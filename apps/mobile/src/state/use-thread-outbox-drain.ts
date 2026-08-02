import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { toUploadChatImageAttachments } from "../lib/composerImages";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  markThreadOutboxMessageFailed,
  removeThreadOutboxMessage,
} from "./thread-outbox";
import {
  isQueuedThreadCreationSendable,
  isQueuedThreadMessageFailed,
  isQueuedThreadMessagePendingCleanup,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadOutboxDeliveryAction,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

function failureReasonFrom(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return typeof error === "string" ? error : undefined;
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): boolean => {
      if (!AsyncResult.isFailure(commandResult)) {
        return false;
      }
      const action = resolveThreadOutboxFailureAction({
        stage,
        error: Cause.squash(commandResult.cause),
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      const retry = action === "retry";
      console.warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        retry,
      });
      return retry;
    };
    /**
     * A deterministic rejection (e.g. provider access changed while the
     * entry sat in the outbox) means this entry will never send as-is. It
     * is kept in the outbox MARKED FAILED on the CURRENT stored entry (so
     * marking cannot clobber an edit that landed while the rejection
     * round-tripped): still visible and editable exactly where it already
     * lives, never dispatched again until an editor save clears the markers
     * and requeues it, deletable at any time. A failed entry blocks only
     * its own thread's queue — deliberately, since delivering later
     * messages around it would reorder the conversation (and they would
     * usually fail the same way).
     *
     * Returns whether the queue slot settled; `false` retries the marking
     * on a later pass with backoff.
     */
    const markEntryFailed = async (reason: string | undefined): Promise<boolean> => {
      try {
        // "marked" and "missing" (deleted or delivered concurrently — that
        // outcome wins) both settle the slot.
        await markThreadOutboxMessageFailed(queuedMessage.messageId, {
          failedAt: new Date().toISOString(),
          ...(reason !== undefined ? { failureReason: reason } : {}),
        });
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to mark rejected queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
      const failed = AsyncResult.isFailure(deliveryResult);
      if (failed) {
        if (reportFailure(deliveryResult, "start-turn")) {
          return false;
        }
        return markEntryFailed(failureReasonFrom(Cause.squash(deliveryResult.cause)));
      }

      try {
        await removeThreadOutboxMessage(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    };
    return { reportFailure, completeDelivery, markEntryFailed };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);
      const { reportFailure, completeDelivery, markEntryFailed } =
        makeDeliveryHelpers(queuedMessage);
      // A deterministic settings-sync rejection (e.g. the queued selection
      // is no longer allowed in this project) can never succeed on retry;
      // mark the entry failed, same as a deterministic start-turn failure.
      const failSettingsSync = async (
        result: AtomCommandResult<unknown, unknown>,
      ): Promise<boolean> => {
        if (!AsyncResult.isFailure(result) || reportFailure(result, "settings-sync")) {
          return false;
        }
        return markEntryFailed(failureReasonFrom(Cause.squash(result.cause)));
      };

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          return failSettingsSync(updateResult);
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          return failSettingsSync(runtimeResult);
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: queuedMessage.createdAt,
          },
        });
        if (AsyncResult.isFailure(interactionResult)) {
          return failSettingsSync(interactionResult);
        }
      }

      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: toUploadChatImageAttachments(queuedMessage.attachments),
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      return completeDelivery(deliveryResult);
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
    ],
  );

  const sendQueuedCreation = useCallback(
    async (
      queuedMessage: QueuedThreadMessage,
      creation: QueuedThreadCreation,
      projectCwd: string,
    ) => {
      const modelSelection = queuedMessage.modelSelection;
      if (modelSelection === undefined) {
        return false;
      }
      const { completeDelivery } = makeDeliveryHelpers(queuedMessage);
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: buildProjectThreadStartTurnInput({
          projectId: creation.projectId,
          projectCwd,
          threadId: queuedMessage.threadId,
          commandId: queuedMessage.commandId,
          messageId: queuedMessage.messageId,
          createdAt: queuedMessage.createdAt,
          text: queuedMessage.text.trim(),
          attachments: queuedMessage.attachments,
          modelSelection,
          runtimeMode: queuedMessage.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: queuedMessage.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceMode: creation.workspaceMode,
          branch: creation.branch,
          worktreePath: creation.worktreePath,
          startFromOrigin: creation.startFromOrigin ?? false,
          worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
        }),
      });
      return completeDelivery(deliveryResult);
    },
    [makeDeliveryHelpers, startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }
      // A durable cleanup intent outranks everything else: the thread was
      // explicitly deleted and only the storage removal is still owed. This
      // resumes a removal that failed earlier (or before a restart); the
      // entry is hidden from every surface until it lands.
      if (isQueuedThreadMessagePendingCleanup(nextQueuedMessage)) {
        beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
        void removeThreadOutboxMessage(nextQueuedMessage)
          .then(
            () => {
              retryAttemptRef.current.delete(nextQueuedMessage.messageId);
              retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            },
            (error) => {
              console.warn("[thread-outbox] failed to resume deleted-thread cleanup", {
                environmentId: nextQueuedMessage.environmentId,
                threadId: nextQueuedMessage.threadId,
                messageId: nextQueuedMessage.messageId,
                error,
              });
              const retryAttempt =
                (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
              retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
              const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
              retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
              const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
              if (pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
              }
              retryTimersRef.current.set(
                nextQueuedMessage.messageId,
                setTimeout(() => {
                  retryTimersRef.current.delete(nextQueuedMessage.messageId);
                  setRetryTick((current) => current + 1);
                }, retryDelayMs),
              );
            },
          )
          .finally(() => {
            finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
          });
        return;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      // Legacy migration: an entry the removed v3 recovery machine already
      // restored into a composer draft needs only removal — it must never
      // be delivered (the content would send twice).
      const deliveryAction: ThreadOutboxDeliveryAction =
        nextQueuedMessage.restoredAt !== undefined
          ? "remove"
          : resolveThreadOutboxDeliveryAction({
              isCreation: creation !== undefined,
              threadExists: thread !== undefined,
              shellStatus,
              environmentConnected: environment?.connectionState === "connected",
              threadBusy:
                thread?.session?.status === "running" || thread?.session?.status === "starting",
            });
      // A failed entry is NEVER auto-resolved by the drain: shell presence
      // is not lifecycle evidence. A thread absent from the shell may be
      // archived, not deleted (discarding would lose content that returns
      // on unarchive), and a thread PRESENT may be a failed bootstrap's
      // transient row awaiting server cleanup (removing would mistake the
      // doomed attempt for delivery). Explicit user deletion of a thread
      // clears its outbox queue at delete time; everything else waits for
      // the user to edit, retry, or delete the entry.
      if (isQueuedThreadMessageFailed(nextQueuedMessage)) {
        continue;
      }
      if (deliveryAction === "wait") {
        continue;
      }
      // The live project shell is preferred for the workspace path, with the
      // snapshot taken at enqueue time as the fallback so a task never dies
      // just because its project shell is not loaded.
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;
      // An incomplete pending task (e.g. worktree mode without a branch) stays
      // queued until the user finishes it in the editor.
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          continue;
        }
        if (creationProjectCwd === null && shellStatus !== "live") {
          continue;
        }
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId: nextQueuedMessage.messageId,
              error,
            });
            return false;
          },
        );
      // Enqueues publish optimistically before their durable write settles.
      // Confirm the write landed (and the message wasn't rolled back) before
      // sending, so a failed write can never chase an already-delivered turn.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          // Rolled back by a failed write; nothing to deliver or retry.
          return true;
        }
        // The guards evaluated before the confirmation await are stale by now:
        // the thread may have gone busy, or the user may have opened this
        // message in the editor. Re-read both and defer to the next drain pass
        // (returning true skips the failure/backoff path) rather than sending
        // a payload the user is editing or racing an active turn.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[nextQueuedMessage.messageId]) {
          return true;
        }
        const freshThread = findThread(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          nextQueuedMessage,
        );
        const freshThreadBusy =
          freshThread?.session?.status === "running" || freshThread?.session?.status === "starting";
        if (deliveryAction === "send" && creation === undefined && freshThreadBusy) {
          return true;
        }
        return deliveryAction === "remove"
          ? removeQueuedMessage(
              nextQueuedMessage.restoredAt !== undefined
                ? "[thread-outbox] failed to remove already-restored message"
                : "[thread-outbox] failed to remove message for a missing thread",
            )
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : // No project and no snapshot cwd: the task cannot ever send.
                // Mark it failed instead of dropping it — the entry is the
                // only record of the user's content.
                makeDeliveryHelpers(nextQueuedMessage).markEntryFailed(
                  "This task's project is no longer available.",
                )
            : thread !== undefined
              ? sendQueuedMessage(nextQueuedMessage, thread)
              : Promise.resolve(false);
      });
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedCreation,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
