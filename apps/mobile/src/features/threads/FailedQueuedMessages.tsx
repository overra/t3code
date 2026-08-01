import { memo, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { placeContentInEmptyComposerDraft } from "../../state/use-composer-drafts";
import {
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";

function confirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Moves a failed message's content into the thread's composer draft for
 * editing, then retires the outbox entry. The draft write is ONE
 * conditional transaction (hydration-aware empty check + attachment-cap
 * check + durable persist); the entry is deleted only after it succeeds,
 * so a crash between the two shows the content twice, never zero times.
 *
 * Editing DEQUEUES the message: anything queued behind it resumes sending,
 * and the edited content re-enters at the tail when resent. When messages
 * are queued behind, that reorder happens only with explicit consent.
 */
async function editIntoComposer(
  message: QueuedThreadMessage,
  queuedBehindCount: number,
): Promise<void> {
  if (queuedBehindCount > 0) {
    const proceed = await confirm(
      "Edit failed message?",
      `${queuedBehindCount} message${queuedBehindCount === 1 ? "" : "s"} queued behind it will send while you edit.`,
      "Edit",
    );
    if (!proceed) {
      return;
    }
  }
  const threadKey = scopedThreadKey(message.environmentId, message.threadId);
  try {
    const placement = await placeContentInEmptyComposerDraft(threadKey, {
      text: message.text,
      attachments: message.attachments,
    });
    if (placement === "occupied") {
      Alert.alert(
        "Composer is not empty",
        "Send or clear the composer first, then edit this failed message.",
      );
      return;
    }
    if (placement === "does-not-fit") {
      Alert.alert(
        "Too many attachments",
        "This message's attachments exceed what the composer can hold.",
      );
      return;
    }
    if (placement === "hydration-failed") {
      Alert.alert(
        "Could not read saved drafts",
        "Your saved drafts could not be loaded, so the message was left in place. Try again.",
      );
      return;
    }
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

async function deleteFailedMessage(message: QueuedThreadMessage): Promise<void> {
  const proceed = await confirm(
    "Delete failed message?",
    "Its text and attachments will be discarded.",
    "Delete",
  );
  if (!proceed) {
    return;
  }
  try {
    await removeThreadOutboxMessage(message);
  } catch (error) {
    Alert.alert(
      "Could not delete message",
      error instanceof Error ? error.message : "The failed message could not be deleted.",
    );
  }
}

function FailedMessageAction(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-zinc-500/10 px-2.5 py-1 dark:bg-zinc-500/16"
      style={({ pressed }) => ({ opacity: props.disabled ? 0.4 : pressed ? 0.6 : 1 })}
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
 * messages in this thread's queue. The three actions are MUTUALLY
 * EXCLUSIVE: while one runs, all are disabled, so a Retry can never
 * dispatch an entry that an Edit is concurrently copying out.
 */
export const FailedQueuedMessages = memo(function FailedQueuedMessages(props: {
  readonly failedMessages: ReadonlyArray<QueuedThreadMessage>;
  /** Non-failed messages queued behind these in the same thread. */
  readonly queuedBehindCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const runExclusive = (action: () => Promise<void>) => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    void action().finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };

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
            <FailedMessageAction
              label="Edit"
              disabled={busy}
              onPress={() => runExclusive(() => editIntoComposer(message, props.queuedBehindCount))}
            />
            <FailedMessageAction
              label="Retry"
              disabled={busy}
              onPress={() => runExclusive(() => retryFailedMessage(message))}
            />
            <FailedMessageAction
              destructive
              label="Delete"
              disabled={busy}
              onPress={() => runExclusive(() => deleteFailedMessage(message))}
            />
          </View>
        </View>
      ))}
    </Animated.View>
  );
});
