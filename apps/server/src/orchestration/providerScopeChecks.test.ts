import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectProviderScopeChecks } from "./providerScopeChecks.ts";

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

  it("resolves thread.turn.start targets through the bootstrap project when present", () => {
    expect(
      collectProviderScopeChecks(
        turnStartCommand({
          modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
        }),
      ),
    ).toEqual([{ instanceId: WORK_INSTANCE, target: { kind: "thread", threadId: THREAD_ID } }]);

    expect(
      collectProviderScopeChecks(
        turnStartCommand({
          modelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
          bootstrapModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
        }),
      ),
    ).toEqual([{ instanceId: WORK_INSTANCE, target: { kind: "project", projectId: PROJECT_ID } }]);
  });

  it("checks a bootstrap selection that differs from the turn selection", () => {
    const checks = collectProviderScopeChecks(
      turnStartCommand({
        modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5.4-codex" },
        bootstrapModelSelection: { instanceId: WORK_INSTANCE, model: "claude-opus-4-6" },
      }),
    );
    expect(checks).toEqual([
      { instanceId: CODEX_INSTANCE, target: { kind: "project", projectId: PROJECT_ID } },
      { instanceId: WORK_INSTANCE, target: { kind: "project", projectId: PROJECT_ID } },
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
