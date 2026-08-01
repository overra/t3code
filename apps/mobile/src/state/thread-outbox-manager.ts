import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  type QueuedThreadMessage,
  type ThreadOutboxFailureMarkers,
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
  // Last DURABLY COMMITTED entry per id — maintained inside the serialized
  // mutation queue. The queued atom may briefly run ahead of it (enqueue
  // publishes optimistically), so this map — never the atom — is the
  // baseline that failed writes roll back to and that awaited publications
  // are validated against. Without it, chained/interleaved mutations can
  // leave the atom and disk permanently divergent.
  const committedById = new Map<MessageId, QueuedThreadMessage>();

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
      // The committed baseline is tracked BY IDENTITY against the published
      // atom objects. Ids already live in the atom AND committed keep their
      // existing mapping: overwriting them with the freshly DECODED (equal
      // but different) object would make every later update/mark/remove
      // treat the atom entry as an uncommitted optimistic resubmission
      // forever. A live id with NO committed entry, though, is an optimistic
      // enqueue that raced this load — the persisted entry IS its rollback
      // baseline, and skipping it would let that enqueue's write failure
      // drop the atom entry while its durable predecessor stays on disk.
      const liveMessageIds = new Set(currentMessages().map((message) => message.messageId));
      for (const message of persistedMessages) {
        if (!liveMessageIds.has(message.messageId) || !committedById.has(message.messageId)) {
          committedById.set(message.messageId, message);
        }
      }
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
  // message in a copy would break both. Only the LEGACY `restoredAt` marker
  // is monotonic (its content already lives in a composer draft; the entry
  // must never redeliver). Failure markers are deliberately NOT preserved:
  // an editor save or a re-enqueue of the same id is an explicit requeue.
  const withPreservedRestoredMarker = (
    message: QueuedThreadMessage,
    existing: QueuedThreadMessage | undefined,
  ): QueuedThreadMessage => {
    if (existing === undefined) return message;
    if (message.restoredAt !== undefined || existing.restoredAt === undefined) return message;
    return { ...message, restoredAt: existing.restoredAt };
  };

  // The queued atom drives the composer's immediate "queued" feedback, so it
  // is published synchronously; the durable write happens behind it and rolls
  // the message back out if it fails (durability only matters for crash
  // recovery, not for the in-session queue).
  const enqueue = (message: QueuedThreadMessage): Promise<void> => {
    const displaced = currentMessages().find(
      (candidate) => candidate.messageId === message.messageId,
    );
    const merged = withPreservedRestoredMarker(message, displaced);
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== merged.messageId),
      merged,
    ]);
    return serialize(async () => {
      try {
        await options.storage.write(merged);
        committedById.set(merged.messageId, merged);
      } catch (cause) {
        // Roll back by reference, not messageId: a retry enqueue with the same
        // id may have optimistically replaced this attempt while the write was
        // in flight, and its entry must survive this attempt's failure. When
        // this attempt is still the live entry, what comes back is the last
        // DURABLY COMMITTED entry — not the optimistic one it displaced,
        // whose own write may also have failed. Disk and atom stay aligned.
        const committed = committedById.get(merged.messageId);
        setMessages(
          currentMessages().flatMap((candidate) =>
            candidate === merged ? (committed !== undefined ? [committed] : []) : [candidate],
          ),
        );
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
  // flush can never resurrect it. An update CLEARS failure markers — saving
  // an edit is the explicit requeue gesture for a failed entry — while the
  // legacy `restoredAt` marker stays monotonic. Returns whether the message
  // was updated.
  const update = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => {
      const existing = currentMessages().find(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (existing === undefined) {
        return false;
      }
      // An entry that differs from the committed baseline is an OPTIMISTIC
      // resubmission whose durable write is still queued behind this op —
      // that write owns the final disk and atom state for this id. Writing
      // or publishing over it would leave disk and atom divergent; report
      // "not updated" so the caller keeps its draft.
      if (committedById.get(message.messageId) !== existing) {
        return false;
      }
      const merged = withPreservedRestoredMarker(message, existing);
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
      committedById.set(merged.messageId, merged);
      // An optimistic enqueue may also have replaced this id DURING the
      // awaited write. Its serialized write runs after this one, so it owns
      // the outcome; republishing the pre-await merge would stomp it.
      const successor = currentMessages().find(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (successor !== existing) {
        return true;
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        merged,
      ]);
      return true;
    });

  // Applies failure markers to the CURRENT stored entry — never to a
  // caller-captured snapshot — so marking cannot clobber content edits made
  // while the rejection round-tripped. "missing" means the entry no longer
  // exists (deleted or delivered concurrently); nothing is written then.
  const markFailed = (
    messageId: MessageId,
    markers: ThreadOutboxFailureMarkers,
  ): Promise<"marked" | "missing"> =>
    serialize(async () => {
      const existing = currentMessages().find((candidate) => candidate.messageId === messageId);
      if (existing === undefined) {
        return "missing";
      }
      // The current entry is an optimistic resubmission whose durable write
      // is still queued behind this op: the failure being reported belongs
      // to the attempt that resubmission superseded. Marking it would strand
      // the atom failed while the pending write leaves disk unfailed.
      if (committedById.get(messageId) !== existing) {
        return "marked";
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
      committedById.set(messageId, merged);
      // Superseded by an optimistic re-enqueue mid-await: its write follows
      // and legitimately clears the markers — do not stomp it in the atom.
      const successor = currentMessages().find((candidate) => candidate.messageId === messageId);
      if (successor !== existing) {
        return "marked";
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== messageId),
        merged,
      ]);
      return "marked";
    });

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      const committedAtStart = committedById.get(message.messageId);
      const existing = currentMessages().find(
        (candidate) => candidate.messageId === message.messageId,
      );
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
      committedById.delete(message.messageId);
      // Drop the entry from the atom only when it is the committed one this
      // removal targeted. An optimistic resubmission (whose serialized write
      // follows and re-creates the id on disk) stays published.
      if (existing !== undefined && existing === committedAtStart) {
        setMessages(currentMessages().filter((candidate) => candidate !== existing));
      }
    });

  // Explicit-lifecycle cleanup: removes every queued entry (failed ones
  // included) for a thread the user just DELETED. This is the only path
  // that resolves failed entries without user action on the entry itself —
  // the deletion is the lifecycle evidence the drain deliberately lacks.
  //
  // Each entry is first marked with a DURABLE cleanup intent, then removed.
  // The intent is what makes a failed removal recoverable: the entry stays
  // marked on disk, hidden from every surface, and the drain retries the
  // removal (across restarts) until it succeeds. Without it, one failed
  // file delete would strand the entry forever — its thread is gone, so no
  // UI could ever reach it.
  const clearThread = (environmentId: EnvironmentId, threadId: ThreadId): Promise<void> =>
    serialize(async () => {
      const targets = currentMessages().filter(
        (message) => message.environmentId === environmentId && message.threadId === threadId,
      );
      const threadDeletedAt = new Date().toISOString();
      const removedMessageIds = new Set<MessageId>();
      const markedById = new Map<MessageId, QueuedThreadMessage>();
      await Promise.all(
        targets.map(async (message) => {
          const marked: QueuedThreadMessage = { ...message, threadDeletedAt };
          try {
            await options.storage.write(marked);
            committedById.set(message.messageId, marked);
            markedById.set(message.messageId, marked);
          } catch (cause) {
            // Intent not durable; still attempt the removal below, and warn.
            warn(
              "[thread-outbox] failed to record deleted-thread cleanup intent",
              new ThreadOutboxManagerError({
                operation: "update",
                environmentId: message.environmentId,
                threadId: message.threadId,
                messageId: message.messageId,
                cause,
              }),
            );
          }
          try {
            await options.storage.remove(message);
            removedMessageIds.add(message.messageId);
            committedById.delete(message.messageId);
          } catch (cause) {
            warn(
              "[thread-outbox] failed to clear queued message for deleted thread",
              new ThreadOutboxManagerError({
                operation: "remove",
                environmentId: message.environmentId,
                threadId: message.threadId,
                messageId: message.messageId,
                cause,
              }),
            );
          }
        }),
      );
      setMessages(
        currentMessages().flatMap((message) => {
          if (removedMessageIds.has(message.messageId)) return [];
          const marked = markedById.get(message.messageId);
          // Removal failed but the intent is durable: keep the MARKED entry
          // so the drain resumes its removal.
          return marked !== undefined && message.messageId === marked.messageId
            ? [marked]
            : [message];
        }),
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
              committedById.delete(message.messageId);
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
    markFailed,
    remove,
    clearThread,
    clearEnvironment,
  };
}
