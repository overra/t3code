import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  type QueuedThreadMessage,
  type ThreadOutboxRecoveryMarkers,
} from "./thread-outbox-model";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

export class ThreadOutboxManagerError extends Schema.TaggedErrorClass<ThreadOutboxManagerError>()(
  "ThreadOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "update",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}.`;
  }
}

export interface ThreadOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadOutboxStorage;
  readonly warn?: (message: string, error: unknown) => void;
}

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions) {
  const queuedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:queued-messages"));
  const warn =
    options.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error);
    });
  let loadPromise: Promise<void> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(queuedMessagesByThreadKeyAtom));

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void => {
    options.registry.set(queuedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages));
  };

  const load = (): Promise<void> => {
    if (loadPromise !== null) {
      return loadPromise;
    }
    loadPromise = serialize(async () => {
      const persistedMessages = await options.storage.load();
      setMessages([...persistedMessages, ...currentMessages()]);
    }).catch((cause) => {
      loadPromise = null;
      warn(
        "[thread-outbox] failed to load persisted messages",
        new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause,
        }),
      );
    });
    return loadPromise;
  };

  // Returns `message` by IDENTITY when nothing needs preserving: enqueue's
  // rollback and confirmQueued compare by reference, and wrapping every
  // message in a copy would break both.
  const withPreservedRecoveryMarkers = (
    message: QueuedThreadMessage,
    existing: QueuedThreadMessage | undefined,
  ): QueuedThreadMessage => {
    if (existing === undefined) return message;
    const preserveRecoveryStarted =
      message.recoveryStartedAt === undefined && existing.recoveryStartedAt !== undefined;
    const preserveRestored = message.restoredAt === undefined && existing.restoredAt !== undefined;
    if (!preserveRecoveryStarted && !preserveRestored) return message;
    return {
      ...message,
      ...(preserveRecoveryStarted ? { recoveryStartedAt: existing.recoveryStartedAt } : {}),
      ...(preserveRestored ? { restoredAt: existing.restoredAt } : {}),
    };
  };

  // The queued atom drives the composer's immediate "queued" feedback, so it
  // is published synchronously; the durable write happens behind it and rolls
  // the message back out if it fails (durability only matters for crash
  // recovery, not for the in-session queue). Re-enqueueing an id preserves
  // any recovery markers the stored entry carries — a resubmission must not
  // make a recovery-committed entry deliverable again.
  const enqueue = (message: QueuedThreadMessage): Promise<void> => {
    const merged = withPreservedRecoveryMarkers(
      message,
      currentMessages().find((candidate) => candidate.messageId === message.messageId),
    );
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== merged.messageId),
      merged,
    ]);
    return serialize(async () => {
      try {
        await options.storage.write(merged);
      } catch (cause) {
        // Roll back by reference, not messageId: a retry enqueue with the same
        // id may have optimistically replaced this attempt while the write was
        // in flight, and its entry must survive this attempt's failure.
        setMessages(currentMessages().filter((candidate) => candidate !== merged));
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
    });
  };

  // Resolves once all pending mutations (including any in-flight enqueue
  // write) have settled, reporting whether the message is still queued. The
  // drain awaits this before dispatching so a message whose durable write
  // later fails can never have been delivered first.
  const confirmQueued = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => currentMessages().some((candidate) => candidate === message));

  // Rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Recovery markers are MONOTONIC: once set
  // on the stored entry they survive any content rewrite, so an editor save
  // racing the recovery flow can never make an already-restored entry
  // deliverable again. Returns whether the message was updated.
  const update = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => {
      const existing = currentMessages().find(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (existing === undefined) {
        return false;
      }
      const merged = withPreservedRecoveryMarkers(message, existing);
      try {
        await options.storage.write(merged);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        merged,
      ]);
      return true;
    });

  // Reads the CURRENT stored entry once pending mutations settle. Recovery
  // must restore what is stored NOW, not a snapshot captured before the
  // rejection round-trip — an edit landing meanwhile would otherwise be
  // silently discarded.
  const getById = (messageId: MessageId): Promise<QueuedThreadMessage | undefined> =>
    serialize(async () => currentMessages().find((candidate) => candidate.messageId === messageId));

  // Applies recovery markers to the CURRENT stored entry — never to a
  // caller-captured snapshot — so marking cannot clobber content edits made
  // while a rejection was in flight. "missing" means the entry no longer
  // exists (deleted concurrently); with `expect` provided, "stale" means the
  // stored content changed since the caller read it (an edit landed
  // mid-recovery) — in both cases nothing was written.
  const mark = (
    messageId: MessageId,
    markers: ThreadOutboxRecoveryMarkers,
    expect?: {
      readonly text: string;
      readonly attachmentIds: ReadonlyArray<string>;
    },
  ): Promise<"marked" | "missing" | "stale"> =>
    serialize(async () => {
      const existing = currentMessages().find((candidate) => candidate.messageId === messageId);
      if (existing === undefined) {
        return "missing";
      }
      if (expect !== undefined) {
        const attachmentIds = existing.attachments.map((attachment) => attachment.id);
        const contentMatches =
          existing.text === expect.text &&
          attachmentIds.length === expect.attachmentIds.length &&
          attachmentIds.every((id, index) => id === expect.attachmentIds[index]);
        if (!contentMatches) {
          return "stale";
        }
      }
      const merged: QueuedThreadMessage = { ...existing, ...markers };
      try {
        await options.storage.write(merged);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: existing.environmentId,
          threadId: existing.threadId,
          messageId: existing.messageId,
          cause,
        });
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== messageId),
        merged,
      ]);
      return "marked";
    });

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      try {
        await options.storage.remove(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "remove",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
    });

  const clearEnvironment = (environmentId: EnvironmentId): Promise<void> =>
    serialize(async () => {
      const persisted = await options.storage.load().catch((cause) => {
        warn(
          "[thread-outbox] failed to load messages while clearing environment",
          new ThreadOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          }),
        );
        return [];
      });
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      );
      const removedMessageIds = new Set<MessageId>();

      await Promise.all(
        allMessages
          .filter((message) => message.environmentId === environmentId)
          .map(async (message) => {
            try {
              await options.storage.remove(message);
              removedMessageIds.add(message.messageId);
            } catch (cause) {
              warn(
                "[thread-outbox] failed to clear persisted message",
                new ThreadOutboxManagerError({
                  operation: "clear-environment-remove",
                  environmentId: message.environmentId,
                  threadId: message.threadId,
                  messageId: message.messageId,
                  cause,
                }),
              );
            }
          }),
      );

      setMessages(allMessages.filter((message) => !removedMessageIds.has(message.messageId)));
    });

  return {
    queuedMessagesByThreadKeyAtom,
    serialize,
    load,
    enqueue,
    confirmQueued,
    update,
    getById,
    mark,
    remove,
    clearEnvironment,
  };
}
