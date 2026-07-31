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

import { scopedProjectKey, scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { toUploadChatImageAttachments } from "../lib/composerImages";
import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import {
  confirmThreadOutboxMessageQueued,
  ensureThreadOutboxLoaded,
  getThreadOutboxMessageById,
  markThreadOutboxMessageRecovery,
  removeThreadOutboxMessage,
} from "./thread-outbox";
import { environmentProjects } from "./projects";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContentIfFits,
  restoreComposerDraftSnapshotOnce,
  retractComposerDraftRestore,
} from "./use-composer-drafts";
import {
  isQueuedThreadCreationSendable,
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
     * entry sat in the outbox) means this entry will never send — but the
     * user's content must not vanish with it. Text and attachments are
     * restored into the composer draft the entry came from: the thread's
     * draft for a message on an existing thread, the project's new-task
     * draft for a queued creation (that thread was never created). The
     * poisoned entry is then removed so it stops blocking the FIFO.
     *
     * Recovery is a DURABLE PHASE MACHINE ordered for crash safety, with
     * each marker written to the CURRENT stored entry (so it cannot clobber
     * concurrent edits) and each phase gating the next:
     *   1. `recoveryStartedAt` commits the entry to recovery BEFORE any
     *      draft write — a crash right after leaves an entry that restart
     *      reconciliation routes back here (never to delivery), and the
     *      restore below is idempotent.
     *   2. The draft restore itself (durable, all-or-nothing).
     *   3. `restoredAt` records completion — a crash before it re-runs the
     *      idempotent restore; after it, only removal remains even if the
     *      user sends the recovered draft (clearing its receipt).
     *   4. Removal.
     *
     * Returns whether the entry was fully resolved; `false` keeps it queued
     * for a later pass with backoff.
     */
    const discardPoisonedEntry = async (): Promise<boolean> => {
      const warnContext = {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
      };
      // Operate on the CURRENT stored entry, never the captured dispatch
      // snapshot: an edit can land while the rejection round-trips, and
      // restoring the stale capture would silently discard the correction.
      const entry = await getThreadOutboxMessageById(queuedMessage.messageId);
      if (entry === undefined) {
        // Deleted concurrently — the deletion wins; nothing is restored.
        return true;
      }
      const receiptId = `thread-outbox:${entry.messageId}`;
      const expectedContent = {
        text: entry.text,
        attachmentIds: entry.attachments.map((attachment) => attachment.id),
      };
      if (entry.restoredAt === undefined) {
        if (entry.creation !== undefined) {
          // A creation whose project no longer exists has no reachable
          // destination draft — restoring there would strand the content
          // behind a key no UI can open, and removing the entry would erase
          // the only record that can still present it. Keep it queued and
          // visible (it blocks only its own never-created thread's queue).
          const projectExists = appAtomRegistry
            .get(environmentProjects.projectsAtom)
            .some(
              (project) =>
                project.environmentId === entry.environmentId &&
                project.id === entry.creation?.projectId,
            );
          if (!projectExists) {
            console.warn(
              "[thread-outbox] kept poisoned pending task; its project no longer exists",
              warnContext,
            );
            return false;
          }
          // Best-effort occupancy check BEFORE committing to recovery, so a
          // content-occupied destination defers with the entry still whole,
          // deliverable-if-policy-changes, and editable. (The restore itself
          // re-checks atomically; entries committed past this point remain
          // VISIBLE in the pending-task list until restoredAt.)
          const destination = getComposerDraftSnapshot(
            `new-task:${scopedProjectKey(entry.environmentId, entry.creation.projectId)}`,
          );
          if (
            entry.recoveryStartedAt === undefined &&
            (destination.text.length > 0 || destination.attachments.length > 0)
          ) {
            console.warn(
              "[thread-outbox] deferred poisoned pending-task recovery; the new-task draft has content",
              warnContext,
            );
            return false;
          }
        }
        if (entry.recoveryStartedAt === undefined) {
          let commit: "marked" | "missing" | "stale";
          try {
            commit = await markThreadOutboxMessageRecovery(entry.messageId, {
              recoveryStartedAt: new Date().toISOString(),
            });
          } catch (error) {
            // Not committed: nothing was restored, the entry stays whole.
            console.warn("[thread-outbox] failed to commit poisoned queued message recovery", {
              ...warnContext,
              error,
            });
            return false;
          }
          if (commit === "missing") {
            // Deleted concurrently before recovery began — deletion wins.
            return true;
          }
        }
        try {
          if (entry.creation !== undefined) {
            // ONE durable snapshot write: content plus task shape (workspace
            // selection with startFromOrigin pinned, runtime and interaction
            // modes) — while any settings the user already picked in the
            // destination draft WIN over the task's shape. The revoked model
            // selection is deliberately NOT restored; the flow's clamp picks
            // a usable one.
            const restoreDraftKey = `new-task:${scopedProjectKey(entry.environmentId, entry.creation.projectId)}`;
            const { restored } = await restoreComposerDraftSnapshotOnce(
              restoreDraftKey,
              {
                text: entry.text,
                attachments: entry.attachments,
                workspaceSelection: {
                  mode: entry.creation.workspaceMode,
                  branch: entry.creation.branch,
                  worktreePath: entry.creation.worktreePath,
                  startFromOrigin: entry.creation.startFromOrigin ?? false,
                },
                ...(entry.runtimeMode !== undefined ? { runtimeMode: entry.runtimeMode } : {}),
                ...(entry.interactionMode !== undefined
                  ? { interactionMode: entry.interactionMode }
                  : {}),
              },
              receiptId,
            );
            if (!restored) {
              console.warn(
                "[thread-outbox] deferred poisoned pending-task restore; the new-task draft is in use",
                warnContext,
              );
              return false;
            }
          } else {
            // ALL-OR-NOTHING restore: the merge writes nothing when the
            // draft cannot fit every attachment, so a truncated copy (and a
            // dedup receipt that would block later retries) never persists
            // alongside the retained full original. Once the draft has room
            // — the user sends or trims it — a later pass merges the whole
            // message in one durable write.
            const restoreDraftKey = scopedThreadKey(entry.environmentId, entry.threadId);
            const { merged } = await mergeComposerDraftContentIfFits(restoreDraftKey, {
              text: entry.text,
              attachments: entry.attachments,
              sourceShareId: receiptId,
            });
            if (!merged) {
              console.warn(
                "[thread-outbox] deferred poisoned queued message restore; the thread draft cannot fit its attachments",
                warnContext,
              );
              return false;
            }
          }
        } catch (error) {
          // Content is NOT durably saved; keep the outbox entry rather than
          // lose the message.
          console.warn("[thread-outbox] failed to restore poisoned queued message to draft", {
            ...warnContext,
            error,
          });
          return false;
        }
        // Record completion ON THE ENTRY before removal, CAS-guarded on the
        // content we just restored: if an edit landed mid-restore ("stale")
        // or the user deleted the entry ("missing"), the restored copy is
        // RETRACTED (creations only, and only while untouched) so a
        // superseded or unwanted restore never lingers in the composer. A
        // failed marker write also retracts, closing the window where
        // restored content is actionable without a durable completion
        // marker.
        const retractRestore = async () => {
          if (entry.creation === undefined) return;
          try {
            await retractComposerDraftRestore(
              `new-task:${scopedProjectKey(entry.environmentId, entry.creation.projectId)}`,
              { text: entry.text, attachments: entry.attachments },
              receiptId,
            );
          } catch (error) {
            console.warn("[thread-outbox] failed to retract superseded draft restore", {
              ...warnContext,
              error,
            });
          }
        };
        let marked: "marked" | "missing" | "stale";
        try {
          marked = await markThreadOutboxMessageRecovery(
            entry.messageId,
            { restoredAt: new Date().toISOString() },
            expectedContent,
          );
        } catch (error) {
          console.warn("[thread-outbox] failed to mark poisoned queued message restored", {
            ...warnContext,
            error,
          });
          await retractRestore();
          return false;
        }
        if (marked === "missing") {
          await retractRestore();
          return true;
        }
        if (marked === "stale") {
          // The entry's content changed while we restored the old copy:
          // retract it and retry against the fresh content next pass.
          await retractRestore();
          return false;
        }
      }
      try {
        await removeThreadOutboxMessage(entry);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove poisoned queued message", {
          ...warnContext,
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
        // Resolving the poisoned entry (restored + removed) counts as
        // settling this queue slot: returning its result lets the drain
        // clear the retry bookkeeping instead of scheduling a retry for an
        // entry that no longer exists.
        return discardPoisonedEntry();
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
    return { reportFailure, completeDelivery, discardPoisonedEntry };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);
      const { reportFailure, completeDelivery, discardPoisonedEntry } =
        makeDeliveryHelpers(queuedMessage);
      // A deterministic settings-sync rejection (e.g. the queued selection
      // is no longer allowed in this project) can never succeed on retry;
      // leaving the entry queued would invisibly block every later message
      // in this thread's FIFO. Restore the content and drop the entry, same
      // as a deterministic start-turn failure.
      const failSettingsSync = async (
        result: AtomCommandResult<unknown, unknown>,
      ): Promise<boolean> => {
        if (reportFailure(result, "settings-sync")) {
          return false;
        }
        // A resolved discard (restored + removed) settles this queue slot —
        // see the matching note in completeDelivery.
        return discardPoisonedEntry();
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

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      // Restart reconciliation for the recovery phase machine: an entry
      // already restored needs only removal; an entry that COMMITTED to
      // recovery (crash or failure between marker and restore) must resume
      // the idempotent recovery flow — and neither may ever be delivered.
      const recoveryResumePending =
        nextQueuedMessage.restoredAt === undefined &&
        nextQueuedMessage.recoveryStartedAt !== undefined;
      const deliveryAction: ThreadOutboxDeliveryAction =
        nextQueuedMessage.restoredAt !== undefined || recoveryResumePending
          ? "remove"
          : resolveThreadOutboxDeliveryAction({
              isCreation: creation !== undefined,
              threadExists: thread !== undefined,
              shellStatus,
              environmentConnected: environment?.connectionState === "connected",
              threadBusy:
                thread?.session?.status === "running" || thread?.session?.status === "starting",
            });
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
        return recoveryResumePending
          ? // Resume the durable recovery flow (idempotent restore → mark →
            // remove); the entry is already committed to never deliver.
            makeDeliveryHelpers(nextQueuedMessage).discardPoisonedEntry()
          : deliveryAction === "remove"
            ? removeQueuedMessage(
                nextQueuedMessage.restoredAt !== undefined
                  ? "[thread-outbox] failed to remove already-restored message"
                  : "[thread-outbox] failed to remove message for a missing thread",
              )
            : creation !== undefined
              ? creationProjectCwd !== null
                ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
                : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
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
