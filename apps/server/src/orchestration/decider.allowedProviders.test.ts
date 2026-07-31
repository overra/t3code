import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-restricted");
const THREAD_ID = ThreadId.make("thread-1");
const WORK_INSTANCE = ProviderInstanceId.make("claudeAgent_work");
const PERSONAL_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");

const restrictedProjectReadModel = Effect.fnUntraced(function* (options?: {
  readonly withThread?: boolean;
}) {
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    sequence: 1,
    eventId: EventId.make("evt-project-create"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-project-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: PROJECT_ID,
      title: "Restricted",
      workspaceRoot: "/tmp/restricted",
      defaultModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      allowedProviderInstances: [WORK_INSTANCE, CODEX_INSTANCE],
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  if (options?.withThread !== true) {
    return withProject;
  }
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-thread-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

function threadCreateCommand(instanceId: ProviderInstanceId) {
  return {
    type: "thread.create",
    commandId: CommandId.make("cmd-thread-create-2"),
    threadId: ThreadId.make("thread-2"),
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId, model: "some-model" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  } as const;
}

function turnStartCommand(readModelInstanceId?: ProviderInstanceId) {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-turn-start"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "hello",
      attachments: [],
    },
    ...(readModelInstanceId !== undefined
      ? { modelSelection: { instanceId: readModelInstanceId, model: "some-model" } }
      : {}),
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("decider project provider allowlist", (it) => {
  it.effect("project.create carries the allowlist into the created payload", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-allowlist"),
          projectId: ProjectId.make("project-new"),
          title: "New",
          workspaceRoot: "/tmp/new",
          allowedProviderInstances: [WORK_INSTANCE],
          createdAt: NOW,
        },
        readModel: createEmptyReadModel(NOW),
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect(
        (event.payload as { allowedProviderInstances: unknown }).allowedProviderInstances,
      ).toEqual([WORK_INSTANCE]);
    }),
  );

  it.effect("project.create rejects a default selection outside the allowlist", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-conflict"),
            projectId: ProjectId.make("project-conflict"),
            title: "Conflict",
            workspaceRoot: "/tmp/conflict",
            defaultModelSelection: { instanceId: PERSONAL_INSTANCE, model: "claude-opus-4-6" },
            allowedProviderInstances: [WORK_INSTANCE],
            createdAt: NOW,
          },
          readModel: createEmptyReadModel(NOW),
        }),
      );
      expect(failure.message).toContain(
        "Default provider instance 'claudeAgent' is not in the project's allowed provider instances.",
      );
    }),
  );

  it.effect(
    "project.meta.update auto-clears a default the new allowlist excludes (server-side, race-free)",
    () =>
      Effect.gen(function* () {
        const readModel: OrchestrationReadModel = yield* restrictedProjectReadModel();
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-narrowing"),
            projectId: PROJECT_ID,
            allowedProviderInstances: [CODEX_INSTANCE],
          },
          readModel,
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event.type).toBe("project.meta-updated");
        expect(event.payload).toMatchObject({
          allowedProviderInstances: [CODEX_INSTANCE],
          defaultModelSelection: null,
        });
      }),
  );

  it.effect(
    "project.meta.update rejects an EXPLICITLY requested default outside the allowlist",
    () =>
      Effect.gen(function* () {
        const readModel: OrchestrationReadModel = yield* restrictedProjectReadModel();
        // Asking for this default is an invalid request — acknowledging it
        // and silently writing `null` would report success for the opposite
        // mutation. Auto-clear is reserved for defaults merely inherited
        // from prior state.
        const failure = yield* Effect.flip(
          decideOrchestrationCommand({
            command: {
              type: "project.meta.update",
              commandId: CommandId.make("cmd-project-update-explicit-conflict"),
              projectId: PROJECT_ID,
              defaultModelSelection: { instanceId: PERSONAL_INSTANCE, model: "claude-opus-4-6" },
            },
            readModel,
          }),
        );
        expect(failure.message).toContain(
          "Default provider instance 'claudeAgent' is not in the project's allowed provider instances.",
        );
      }),
  );

  it.effect(
    "project.meta.update accepts a narrowed allowlist when the default is cleared with it",
    () =>
      Effect.gen(function* () {
        const readModel = yield* restrictedProjectReadModel();
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-project-update-narrow"),
            projectId: PROJECT_ID,
            defaultModelSelection: null,
            allowedProviderInstances: [CODEX_INSTANCE],
          },
          readModel,
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event.type).toBe("project.meta-updated");
        expect(event.payload).toMatchObject({
          defaultModelSelection: null,
          allowedProviderInstances: [CODEX_INSTANCE],
        });
      }),
  );

  it.effect("project.meta.update clears the restriction with null", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel();
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-clear"),
          projectId: PROJECT_ID,
          allowedProviderInstances: null,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect(
        (event.payload as { allowedProviderInstances: unknown }).allowedProviderInstances,
      ).toBeNull();
    }),
  );

  it.effect("thread.create rejects a provider instance outside the project allowlist", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel();
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: threadCreateCommand(PERSONAL_INSTANCE),
          readModel,
        }),
      );
      expect(failure.message).toContain(
        "Provider instance 'claudeAgent' is not allowed for project 'project-restricted'.",
      );
    }),
  );

  it.effect("thread.create accepts an allowlisted provider instance", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel();
      const result = yield* decideOrchestrationCommand({
        command: threadCreateCommand(CODEX_INSTANCE),
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.created");
    }),
  );

  it.effect("thread.turn.start rejects an explicit disallowed model selection", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel({ withThread: true });
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: turnStartCommand(PERSONAL_INSTANCE),
          readModel,
        }),
      );
      expect(failure.message).toContain(
        "Provider instance 'claudeAgent' is not allowed for project 'project-restricted'.",
      );
    }),
  );

  it.effect("thread.turn.start without a model selection is not blocked by the decider", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel({ withThread: true });
      const result = yield* decideOrchestrationCommand({
        command: turnStartCommand(),
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("thread.meta.update rejects switching to a disallowed provider instance", () =>
    Effect.gen(function* () {
      const readModel = yield* restrictedProjectReadModel({ withThread: true });
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-thread-meta-update"),
            threadId: THREAD_ID,
            modelSelection: { instanceId: PERSONAL_INSTANCE, model: "claude-opus-4-6" },
          },
          readModel,
        }),
      );
      expect(failure.message).toContain(
        "Provider instance 'claudeAgent' is not allowed for project 'project-restricted'.",
      );
    }),
  );
});
