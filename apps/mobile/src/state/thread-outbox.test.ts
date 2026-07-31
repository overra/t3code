import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return [...stored.values()];
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("marks the CURRENT entry failed and clears the markers on edit or re-enqueue", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(message);

    // markFailed() applies to the CURRENT stored entry — including edits
    // made while the rejection round-tripped — so marking can never clobber
    // concurrently edited content.
    await manager.update({ ...message, text: "edited while rejection was in flight" });
    expect(
      await manager.markFailed(message.messageId, {
        failedAt: "2026-06-08T10:00:05.000Z",
        failureReason: "provider access revoked",
      }),
    ).toBe("marked");
    expect(stored.get(message.messageId)).toMatchObject({
      text: "edited while rejection was in flight",
      failedAt: "2026-06-08T10:00:05.000Z",
      failureReason: "provider access revoked",
    });

    // An editor save is the explicit requeue gesture: it reconstructs the
    // record without the markers and update() lets them clear.
    expect(await manager.update({ ...message, text: "editor save" })).toBe(true);
    expect(stored.get(message.messageId)?.failedAt).toBeUndefined();
    expect(stored.get(message.messageId)?.failureReason).toBeUndefined();

    // Same for a same-id re-enqueue (offline resubmission).
    await manager.markFailed(message.messageId, { failedAt: "2026-06-08T10:00:06.000Z" });
    await manager.enqueue({ ...message, text: "resubmitted" });
    expect(stored.get(message.messageId)).toMatchObject({ text: "resubmitted" });
    expect(stored.get(message.messageId)?.failedAt).toBeUndefined();

    // The LEGACY restoredAt marker stays monotonic through both paths: its
    // content already lives in a composer draft, so the entry must never
    // become deliverable again.
    stored.set(message.messageId, {
      ...stored.get(message.messageId)!,
      restoredAt: "2026-06-08T10:00:07.000Z",
    });
    registry.dispose();
    const registry2 = AtomRegistry.make();
    const manager2 = createThreadOutboxManager({ registry: registry2, storage });
    await manager2.load();
    await manager2.update({ ...message, text: "post-restore editor save" });
    expect(stored.get(message.messageId)).toMatchObject({
      text: "post-restore editor save",
      restoredAt: "2026-06-08T10:00:07.000Z",
    });

    // Marking an entry deleted concurrently writes nothing and reports it.
    await manager2.remove(message);
    expect(
      await manager2.markFailed(message.messageId, { failedAt: "2026-06-08T10:00:08.000Z" }),
    ).toBe("missing");
    expect(stored.size).toBe(0);
    registry2.dispose();
  });

  it("restores the displaced entry when a same-id enqueue's durable write fails", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let failNextWrite = false;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("disk full");
        }
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(original);

    // The replacement's write fails: the durably stored entry it displaced
    // must come back into the queue — dropping it would leave the atom and
    // disk divergent until the next full reload.
    failNextWrite = true;
    await expect(manager.enqueue({ ...original, text: "replacement" })).rejects.toBeInstanceOf(
      ThreadOutboxManagerError,
    );
    const messages = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(original);
    expect(stored.get(original.messageId)?.text).toBe("message-1");
    registry.dispose();
  });

  it("rolls chained failed re-enqueues back to the durable baseline", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let failWrites = false;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        if (failWrites) throw new Error("disk full");
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(original);

    // Both replacements fail durably. The rollback target is the COMMITTED
    // baseline, not the previous optimistic entry — restoring optimistic B
    // (whose own write failed) would leave the atom showing content disk
    // never accepted.
    failWrites = true;
    const second = manager.enqueue({ ...original, text: "replacement-b" }).catch((error) => error);
    const third = manager.enqueue({ ...original, text: "replacement-c" }).catch((error) => error);
    expect(await second).toBeInstanceOf(ThreadOutboxManagerError);
    expect(await third).toBeInstanceOf(ThreadOutboxManagerError);

    const messages = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(original);
    expect(stored.get(original.messageId)?.text).toBe("message-1");
    registry.dispose();
  });

  it("keeps the committed baseline usable when load follows an enqueue", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      // Production storage DECODES fresh objects on every load — the same
      // content under a different identity than what enqueue published.
      load: async () => [...stored.values()].map((message) => ({ ...message })),
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(original);
    await manager.load();

    // The freshly decoded load result must not displace the committed
    // identity of the already-published entry — that would turn every later
    // update into a no-op and leave remove ghosting the atom.
    expect(await manager.update({ ...original, text: "edited" })).toBe(true);
    expect(stored.get(original.messageId)?.text).toBe("edited");
    const afterUpdate = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );
    expect(afterUpdate[0]?.text).toBe("edited");

    await manager.remove(original);
    expect(stored.size).toBe(0);
    expect(
      flattenQueuedThreadMessages(registry.get(manager.queuedMessagesByThreadKeyAtom)),
    ).toHaveLength(0);
    registry.dispose();
  });

  it("keeps atom and disk aligned when a failure mark races an optimistic re-enqueue", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let gate: Promise<void> | null = null;
    let releaseGate!: () => void;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        if (gate !== null) {
          const pending = gate;
          gate = null;
          await pending;
        }
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(original);

    // The failure marker's write blocks while an optimistic re-enqueue of
    // the same id lands. The resubmission postdates the failure, so BOTH
    // stores must end unfailed with the resubmitted content — never atom
    // "failed A" over disk "unfailed B".
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const marking = manager.markFailed(original.messageId, {
      failedAt: "2026-06-08T10:00:05.000Z",
    });
    await Promise.resolve();
    await Promise.resolve();
    const enqueueing = manager.enqueue({ ...original, text: "resubmitted" });
    releaseGate();
    await Promise.all([marking, enqueueing]);

    const messages = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("resubmitted");
    expect(messages[0]?.failedAt).toBeUndefined();
    expect(stored.get(original.messageId)?.text).toBe("resubmitted");
    expect(stored.get(original.messageId)?.failedAt).toBeUndefined();
    registry.dispose();
  });

  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("publishes an enqueued message before the durable write resolves", async () => {
    const registry = AtomRegistry.make();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const enqueueing = manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    releaseWrite();
    await enqueueing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });

  it("rolls an enqueued message back out when the durable write fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          throw writeCause;
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("keeps a same-id retry queued when the first attempt's write fails", async () => {
    const registry = AtomRegistry.make();
    let failNextWrite = true;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            await firstWriteBlocked;
            throw new Error("disk full");
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    const first = manager.enqueue(message);
    const second = manager.enqueue(retried);
    releaseFirstWrite();
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    await second;

    // The failed first attempt must not roll back the retry that replaced it.
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });

  it("replaces an existing message when an enqueue retry uses the same id", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    await manager.enqueue(message);
    await manager.enqueue(retried);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("remove");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings synchronization fails ambiguously", () => {
    const ambiguousFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: ambiguousFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: ambiguousFailure,
        interrupted: false,
      }),
    ).toBe("discard");
  });

  it("drops typed deterministic rejections in BOTH stages so they cannot pin the FIFO", () => {
    const accessDenied = {
      _tag: "OrchestrationDispatchCommandError",
      message: "Provider instance 'claudeAgent' is not allowed for project 'work'.",
    };
    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: accessDenied,
        interrupted: false,
      }),
    ).toBe("discard");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: { _tag: "OrchestrationCommandInvariantError", detail: "not allowed" },
        interrupted: false,
      }),
    ).toBe("discard");
  });

  it("retries dispatch rejections marked retryable (verification outages)", () => {
    const verificationOutage = {
      _tag: "OrchestrationDispatchCommandError",
      message: "Provider access could not be verified (server settings unavailable). Try again.",
      retryable: true,
    };
    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: verificationOutage,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: verificationOutage,
        interrupted: false,
      }),
    ).toBe("retry");
  });
});
