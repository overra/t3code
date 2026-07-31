import { useMemo } from "react";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  flattenQueuedThreadMessages,
  isQueuedThreadMessageFailed,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { useThreadOutboxMessages } from "./use-thread-outbox";

/** A queued new-task creation, shaped for thread-list presentation. */
export interface PendingNewTask {
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly title: string;
  /**
   * Deterministically rejected: the drain will not retry it. The row stays
   * visible and editable — an editor save requeues it, delete removes it.
   */
  readonly failed: boolean;
}

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  return useMemo(() => {
    const tasks: PendingNewTask[] = [];
    for (const message of flattenQueuedThreadMessages(queuedMessagesByThreadKey)) {
      if (!message.creation) {
        continue;
      }
      // Hide only entries the LEGACY recovery machine already restored into
      // a composer draft (removal is imminent; showing them would present
      // the same content twice). Failed entries stay visible and editable.
      if (message.restoredAt !== undefined) {
        continue;
      }
      tasks.push({
        message,
        creation: message.creation,
        title: deriveThreadTitleFromPrompt(message.text),
        failed: isQueuedThreadMessageFailed(message),
      });
    }
    tasks.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
    return tasks;
  }, [queuedMessagesByThreadKey]);
}
