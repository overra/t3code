import type { EnvironmentId, MessageId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage, ThreadOutboxRecoveryMarkers } from "./thread-outbox-model";
import { expoThreadOutboxStorage } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

/** Waits for pending writes to settle; false if the message was rolled back. */
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Rewrite a queued message; no-op (false) if it was removed in the meantime. */
export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.update(message);
}

/** Reads the CURRENT stored entry once pending mutations settle. */
export function getThreadOutboxMessageById(
  messageId: MessageId,
): Promise<QueuedThreadMessage | undefined> {
  return threadOutboxManager.getById(messageId);
}

/**
 * Durably applies recovery markers to the CURRENT stored entry (never a
 * captured snapshot). "missing" = deleted concurrently; "stale" = the
 * stored content no longer matches `expect` (an edit landed mid-recovery).
 * Nothing is written in either non-"marked" case.
 */
export function markThreadOutboxMessageRecovery(
  messageId: MessageId,
  markers: ThreadOutboxRecoveryMarkers,
  expect?: { readonly text: string; readonly attachmentIds: ReadonlyArray<string> },
): Promise<"marked" | "missing" | "stale"> {
  return threadOutboxManager.mark(messageId, markers, expect);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
