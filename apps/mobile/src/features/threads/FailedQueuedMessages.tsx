import { memo } from "react";
import { Alert, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
} from "../../state/use-composer-drafts";
import {
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";

/**
 * Moves a failed message's content into the thread's composer draft for
 * editing, then retires the outbox entry. User-initiated and ordered
 * durable-copy-first: a crash between the two writes shows the content
 * twice (composer and failed entry), never zero times. Refuses while the
 * composer holds content so nothing is silently mixed or clobbered.
 */
async function editIntoComposer(message: QueuedThreadMessage): Promise<void> {
  const threadKey = scopedThreadKey(message.environmentId, message.threadId);
  const draft = getComposerDraftSnapshot(threadKey);
  if (draft.text.trim().length > 0 || draft.attachments.length > 0) {
    Alert.alert(
      "Composer is not empty",
      "Send or clear the composer first, then edit this failed message.",
    );
    return;
  }
  try {
    await mergeComposerDraftContent(threadKey, {
      text: message.text,
      attachments: message.attachments,
    });
    await removeThreadOutboxMessage(message);
  } catch (error) {
    Alert.alert(
      "Could not move message",
      error instanceof Error
        ? error.message
        : "The failed message could not be moved to the composer.",
    );
  }
}

/** Clears the failure markers so the drain dispatches the entry again. */
async function retryFailedMessage(message: QueuedThreadMessage): Promise<void> {
  const {
    failedAt: _failedAt,
    failureReason: _failureReason,
    recoveryStartedAt: _recoveryStartedAt,
    ...requeued
  } = message;
  try {
    await updateThreadOutboxMessage(requeued);
  } catch (error) {
    Alert.alert(
      "Could not retry message",
      error instanceof Error ? error.message : "The failed message could not be requeued.",
    );
  }
}

function confirmDeleteFailedMessage(message: QueuedThreadMessage): void {
  Alert.alert("Delete failed message?", "Its text and attachments will be discarded.", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: () => {
        removeThreadOutboxMessage(message).catch((error) => {
          console.warn("[thread-outbox] failed to delete failed queued message", error);
        });
      },
    },
  ]);
}

function FailedMessageAction(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="rounded-full bg-zinc-500/10 px-2.5 py-1 dark:bg-zinc-500/16"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.destructive
            ? "text-xs font-t3-bold text-red-600 dark:text-red-400"
            : "text-xs font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * Recovery surface for queued messages on an EXISTING thread that were
 * deterministically rejected. Each failed entry shows its content and
 * reason with the full set of resolutions — edit (move to the composer),
 * retry (requeue), delete — since a failed head deliberately holds later
 * messages in this thread's queue.
 */
export const FailedQueuedMessages = memo(function FailedQueuedMessages(props: {
  readonly failedMessages: ReadonlyArray<QueuedThreadMessage>;
}) {
  if (props.failedMessages.length === 0) {
    return null;
  }
  return (
    <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
      {props.failedMessages.map((message) => (
        <View
          key={message.messageId}
          className="mt-2 gap-1 rounded-xl border border-red-500/20 bg-red-500/5 p-3"
        >
          <Text className="text-xs font-t3-bold text-red-600 dark:text-red-400">
            Message failed to send
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {message.failureReason ?? "The server rejected this message."}
          </Text>
          <Text className="text-sm text-foreground" numberOfLines={2}>
            {message.text}
          </Text>
          {message.attachments.length > 0 ? (
            <Text className="text-xs text-foreground-muted">
              {message.attachments.length} attachment
              {message.attachments.length === 1 ? "" : "s"}
            </Text>
          ) : null}
          <View className="mt-1.5 flex-row gap-2">
            <FailedMessageAction label="Edit" onPress={() => void editIntoComposer(message)} />
            <FailedMessageAction label="Retry" onPress={() => void retryFailedMessage(message)} />
            <FailedMessageAction
              destructive
              label="Delete"
              onPress={() => confirmDeleteFailedMessage(message)}
            />
          </View>
        </View>
      ))}
    </Animated.View>
  );
});
