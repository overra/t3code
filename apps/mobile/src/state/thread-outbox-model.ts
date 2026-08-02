import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";

const THREAD_OUTBOX_SCHEMA_VERSION = 3;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  // Snapshot of the project's display metadata so a pending task stays
  // presentable in the thread list even when the project shell is not loaded.
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  // Present when the queued item creates a brand-new thread (pending task)
  // instead of appending a turn to an existing one.
  creation: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
  // A deterministically rejected entry is kept in the outbox as FAILED: it
  // stays visible and editable exactly where it already lives, is never
  // dispatched again, and re-queues when the user edits it (an editor save
  // clears the markers) or disappears when they delete it. There is no
  // cross-store draft-restore handoff.
  failedAt: Schema.optional(IsoDateTime),
  failureReason: Schema.optional(Schema.String),
  // Durable cleanup INTENT, written before removing an explicitly deleted
  // thread's entries. It survives a failed removal (and a restart), so the
  // drain can resume the deletion — without it, one failed file removal
  // would strand the entry forever, since its thread has no UI left.
  threadDeletedAt: Schema.optional(IsoDateTime),
  // LEGACY (schema v3 recovery phase machine, since removed) — retained so
  // stored entries decode. `restoredAt` means the old version durably
  // restored the content into a composer draft: only removal remains. A bare
  // `recoveryStartedAt` means the old version committed to recovery but the
  // restore is unconfirmed: the entry is treated as failed (kept visible and
  // editable) rather than re-delivered or dropped.
  recoveryStartedAt: Schema.optional(IsoDateTime),
  restoredAt: Schema.optional(IsoDateTime),
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  readonly interactionMode?: ProviderInteractionModeType;
  readonly creation?: QueuedThreadCreation;
  readonly createdAt: string;
  /** See the failure/legacy-recovery markers on `QueuedThreadMessageSchema`. */
  readonly failedAt?: string;
  readonly failureReason?: string;
  readonly threadDeletedAt?: string;
  readonly recoveryStartedAt?: string;
  readonly restoredAt?: string;
}

/** Failure markers applied via the outbox manager's markFailed op. */
export interface ThreadOutboxFailureMarkers {
  readonly failedAt: string;
  readonly failureReason?: string;
}

/**
 * A failed entry is skipped by the drain (blocking only its own thread's
 * queue) until an editor save or re-enqueue clears its markers. Includes
 * legacy mid-recovery entries (committed by the removed v3 recovery machine,
 * restore unconfirmed) — kept visible and editable as failed rather than
 * re-delivered or dropped.
 */
export function isQueuedThreadMessageFailed(message: QueuedThreadMessage): boolean {
  if (message.failedAt !== undefined) return true;
  return message.recoveryStartedAt !== undefined && message.restoredAt === undefined;
}

/**
 * Its thread was explicitly deleted and removal is owed: the entry is
 * hidden from every surface and the drain retries its removal (resuming
 * across restarts) until the storage delete finally succeeds.
 */
export function isQueuedThreadMessagePendingCleanup(message: QueuedThreadMessage): boolean {
  return message.threadDeletedAt !== undefined;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly isCreation: boolean;
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
}): ThreadOutboxDeliveryAction {
  if (input.isCreation) {
    // A pending task creates its thread on delivery. If the thread already
    // exists the creation command went through and only cleanup remains.
    if (input.threadExists) {
      return "remove";
    }
    // Wait for the shell to be live before sending: until the thread list has
    // synchronized, a previously delivered creation whose cleanup failed would
    // look missing and get re-issued, duplicating the thread.
    return input.environmentConnected && input.shellStatus === "live" ? "send" : "wait";
  }
  if (!input.threadExists) {
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  return input.environmentConnected && !input.threadBusy ? "send" : "wait";
}

/**
 * A queued creation can only be dispatched once its payload would pass server
 * validation; incomplete payloads stay pending until the user edits them.
 */
export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  if (message.text.trim().length === 0 || message.modelSelection === undefined) {
    return false;
  }
  return message.creation.workspaceMode !== "worktree" || Boolean(message.creation.branch);
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "discard";

function isDispatchRejection(error: unknown): error is { readonly retryable?: boolean } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "OrchestrationDispatchCommandError"
  );
}

/**
 * A typed command rejection the server will repeat on every retry — e.g. a
 * provider-access denial for a selection revoked while the entry sat in the
 * outbox. Dispatch errors explicitly marked `retryable` (verification
 * outages) are NOT deterministic and are retried in both stages.
 */
function isDeterministicCommandRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("_tag" in error)) {
    return false;
  }
  if (error._tag === "OrchestrationCommandInvariantError") {
    return true;
  }
  return isDispatchRejection(error) && error.retryable !== true;
}

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (input.interrupted || shouldRetryThreadOutboxDelivery(input.error)) {
    return "retry";
  }
  if (isDispatchRejection(input.error) && input.error.retryable === true) {
    return "retry";
  }
  // Deterministic rejections poison the queue in EITHER stage: a revoked
  // model selection fails settings-sync forever and would otherwise pin the
  // FIFO head. Unknown settings-sync failures keep their historical retry
  // bias; unknown start-turn failures keep their historical discard bias.
  if (isDeterministicCommandRejection(input.error)) {
    return "discard";
  }
  return input.stage === "settings-sync" ? "retry" : "discard";
}
