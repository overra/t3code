import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  collectProviderScopeChecks,
  validateCommandProviderAccess,
} from "./providerScopeChecks.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const WORK_INSTANCE = ProviderInstanceId.make("claudeAgent_work");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");

function turnStartCommand(input: {
  readonly modelSelection?: { instanceId: ProviderInstanceId; model: string };
  readonly bootstrapModelSelection?: { instanceId: ProviderInstanceId; model: string };
}): OrchestrationCommand {
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
    ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
    ...(input.bootstrapModelSelection !== undefined
      ? {
          bootstrap: {
            createThread: {
              projectId: PROJECT_ID,
              title: "Thread",
              modelSelection: input.bootstrapModelSelection,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
          },
        }
      : {}),
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  };
}

describe("collectProviderScopeChecks", () => {
  it("targets the command's project for thread.create", () => {
    const checks = collectProviderScopeChecks({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    expect(checks).toEqual([
      { instanceId: WORK_INSTANCE, target: { kind: "project", projectId: PROJECT_ID } },
    ]);
  });

  it("targets the thread for thread.meta.update model switches only", () => {
    expect(
      collectProviderScopeChecks({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-meta"),
        threadId: THREAD_ID,
        modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      }),
    ).toEqual([{ instanceId: WORK_INSTANCE, target: { kind: "thread", threadId: THREAD_ID } }]);

    expect(
      collectProviderScopeChecks({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-meta-title"),
        threadId: THREAD_ID,
        title: "Renamed",
      }),
    ).toEqual([]);
  });

  it("targets thread-first with the bootstrap project as fallback for bootstrap turns", () => {
    expect(
      collectProviderScopeChecks(
        turnStartCommand({
          modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
        }),
      ),
    ).toEqual([{ instanceId: WORK_INSTANCE, target: { kind: "thread", threadId: THREAD_ID } }]);

    // The thread wins when it exists — a caller must not be able to spoof a
    // permissive bootstrap project for a turn on an existing thread.
    expect(
      collectProviderScopeChecks(
        turnStartCommand({
          modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
          bootstrapModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
        }),
      ),
    ).toEqual([
      {
        instanceId: WORK_INSTANCE,
        target: {
          kind: "thread-else-project",
          threadId: THREAD_ID,
          fallbackProjectId: PROJECT_ID,
        },
      },
    ]);
  });

  it("checks a bootstrap selection that differs from the turn selection", () => {
    const checks = collectProviderScopeChecks(
      turnStartCommand({
        modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-codex" },
        bootstrapModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      }),
    );
    const target = {
      kind: "thread-else-project",
      threadId: THREAD_ID,
      fallbackProjectId: PROJECT_ID,
    };
    expect(checks).toEqual([
      { instanceId: CODEX_INSTANCE, target },
      { instanceId: WORK_INSTANCE, target },
    ]);
  });

  it("collects nothing for commands without provider selections", () => {
    expect(
      collectProviderScopeChecks({
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive"),
        threadId: THREAD_ID,
      }),
    ).toEqual([]);
  });
});

describe("validateCommandProviderAccess", () => {
  const RESTRICTED_PROJECT_ID = ProjectId.make("project-restricted");
  const restrictedProject: OrchestrationProjectShell = {
    id: RESTRICTED_PROJECT_ID,
    title: "Restricted",
    workspaceRoot: "/tmp/restricted",
    defaultModelSelection: null,
    allowedProviderInstances: [CODEX_INSTANCE],
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  // The bootstrap names PROJECT_ID, which allows everything.
  const permissiveProject: OrchestrationProjectShell = {
    id: PROJECT_ID,
    title: "Permissive",
    workspaceRoot: "/tmp/permissive",
    defaultModelSelection: null,
    allowedProviderInstances: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const threadInRestrictedProject: OrchestrationThreadShell = {
    id: THREAD_ID,
    projectId: RESTRICTED_PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-codex" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const projectShells = new Map<ProjectId, OrchestrationProjectShell>([
    [RESTRICTED_PROJECT_ID, restrictedProject],
    [PROJECT_ID, permissiveProject],
  ]);
  const makeDeps = (thread: OrchestrationThreadShell | undefined) => ({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        thread !== undefined && thread.id === threadId ? Option.some(thread) : Option.none(),
      ),
    getProjectShellById: (projectId: ProjectId) => {
      const project = projectShells.get(projectId);
      return Effect.succeed(project === undefined ? Option.none() : Option.some(project));
    },
  });
  const spoofingTurn = turnStartCommand({
    modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
    bootstrapModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
  });

  it.effect(
    "denies via the EXISTING thread's project even when the bootstrap names a permissive one",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          validateCommandProviderAccess(spoofingTurn, makeDeps(threadInRestrictedProject)),
        );
        expect(failure.message).toContain("claudeAgent_work");
        expect(failure.message).toContain("'Restricted'");
        expect(failure.retryable).not.toBe(true);
      }),
  );

  it.effect("falls back to the bootstrap project when the thread is genuinely new", () =>
    validateCommandProviderAccess(spoofingTurn, makeDeps(undefined)),
  );

  it.effect("fails closed with a retryable error when settings cannot be read", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        validateCommandProviderAccess(spoofingTurn, {
          ...makeDeps(threadInRestrictedProject),
          getSettings: Effect.fail("settings store offline" as const),
        }),
      );
      expect(failure._tag).toBe("OrchestrationDispatchCommandError");
      expect(failure.message).toContain("could not be verified");
      expect(failure.retryable).toBe(true);
    }),
  );
});
