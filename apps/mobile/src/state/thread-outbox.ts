import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage, ThreadOutboxFailureMarkers } from "./thread-outbox-model";
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

/**
 * Durably applies failure markers to the CURRENT stored entry (never a
 * captured snapshot). "missing" = deleted or delivered concurrently;
 * nothing is written then.
 */
export function markThreadOutboxMessageFailed(
  messageId: MessageId,
  markers: ThreadOutboxFailureMarkers,
): Promise<"marked" | "missing"> {
  return threadOutboxManager.markFailed(messageId, markers);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

/**
 * Clears every queued entry (failed included) for an explicitly DELETED
 * thread — the drain itself never auto-resolves failed entries, since
 * shell presence is not lifecycle evidence.
 */
export function clearThreadOutboxForDeletedThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<void> {
  return threadOutboxManager.clearThread(environmentId, threadId);
}

export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}
