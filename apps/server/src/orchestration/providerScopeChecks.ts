/**
 * Instance-scope pre-validation for client-dispatched commands.
 *
 * The project-side allowlist is enforced by the decider (it lives in the
 * orchestration read model). The instance-side `allowedProjects` scope lives
 * in `ServerSettings`, which the decider intentionally cannot see — so the
 * dispatch path (ws.ts) runs this check between normalization and engine
 * dispatch, keeping the decider pure while commands that name a scoped-out
 * instance still fail early with a typed error instead of at first turn.
 *
 * This module only *collects* the (instance, project-or-thread) pairs a
 * command implies; the caller resolves thread → project through the
 * projection and applies the shared scope rule from contracts.
 */
import type {
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export type ProviderScopeCheckTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "thread"; readonly threadId: ThreadId };

export interface ProviderScopeCheck {
  readonly instanceId: ProviderInstanceId;
  readonly target: ProviderScopeCheckTarget;
}

export function collectProviderScopeChecks(
  command: OrchestrationCommand,
): ReadonlyArray<ProviderScopeCheck> {
  switch (command.type) {
    case "thread.create":
      return [
        {
          instanceId: command.modelSelection.instanceId,
          target: { kind: "project", projectId: command.projectId },
        },
      ];
    case "thread.meta.update":
      return command.modelSelection === undefined
        ? []
        : [
            {
              instanceId: command.modelSelection.instanceId,
              target: { kind: "thread", threadId: command.threadId },
            },
          ];
    case "thread.turn.start": {
      const createThread = command.bootstrap?.createThread;
      // With a bootstrap the thread does not exist yet; the bootstrap's
      // projectId is the authoritative target for both selections.
      const turnTarget: ProviderScopeCheckTarget = createThread
        ? { kind: "project", projectId: createThread.projectId }
        : { kind: "thread", threadId: command.threadId };
      const checks: ProviderScopeCheck[] = [];
      if (command.modelSelection !== undefined) {
        checks.push({ instanceId: command.modelSelection.instanceId, target: turnTarget });
      }
      if (
        createThread &&
        createThread.modelSelection.instanceId !== command.modelSelection?.instanceId
      ) {
        checks.push({
          instanceId: createThread.modelSelection.instanceId,
          target: { kind: "project", projectId: createThread.projectId },
        });
      }
      return checks;
    }
    default:
      return [];
  }
}
