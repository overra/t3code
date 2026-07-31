import { useMemo } from "react";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  flattenQueuedThreadMessages,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { useThreadOutboxMessages } from "./use-thread-outbox";

/** A queued new-task creation, shaped for thread-list presentation. */
export interface PendingNewTask {
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly title: string;
}

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  return useMemo(() => {
    const tasks: PendingNewTask[] = [];
    for (const message of flattenQueuedThreadMessages(queuedMessagesByThreadKey)) {
      if (!message.creation) {
        continue;
      }
      // An entry committed to recovery is mid-removal: its content is (or is
      // about to be) the project's new-task draft. Listing it would open the
      // editor over a record the recovery flow is concurrently marking and
      // deleting — edits there would be lost the moment removal lands.
      if (message.recoveryStartedAt !== undefined || message.restoredAt !== undefined) {
        continue;
      }
      tasks.push({
        message,
        creation: message.creation,
        title: deriveThreadTitleFromPrompt(message.text),
      });
    }
    tasks.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
    return tasks;
  }, [queuedMessagesByThreadKey]);
}
