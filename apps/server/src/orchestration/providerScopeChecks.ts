/**
 * Provider-access pre-validation for client-dispatched commands, shared by
 * every dispatch surface (WebSocket and HTTP).
 *
 * The project-side allowlist is enforced by the decider (it lives in the
 * orchestration read model). The instance-side `allowedProjects` scope lives
 * in `ServerSettings`, which the decider intentionally cannot see — so the
 * dispatch path runs this check before normalization and engine dispatch,
 * keeping the decider pure while commands that name a restricted instance
 * fail early with a typed error instead of at first provider turn. Running
 * before normalization also means rejected image turns never persist their
 * attachments to disk.
 *
 * Both rules are evaluated here through the shared contracts predicate so
 * the error names the rule that actually blocks (project allowlist wins
 * attribution, matching `getProviderInstanceProjectRestriction`). Read
 * FAILURES fail closed — "cannot verify access" must not admit a command
 * that verification would have denied (and must not let a denied image turn
 * reach the attachment store). A cleanly MISSING thread or project record
 * passes through instead: the decider owns that error and reports it with
 * proper context.
 */
import {
  getProviderInstanceAllowedProjects,
  getProviderInstanceProjectRestriction,
  OrchestrationDispatchCommandError,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type ProviderScopeCheckTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  /**
   * A bootstrap-bearing turn: when the thread already exists its project is
   * authoritative (the decider ignores the bootstrap for existing threads,
   * so a caller must not be able to spoof a permissive bootstrap project);
   * the bootstrap project applies only when the thread is genuinely new.
   */
  | {
      readonly kind: "thread-else-project";
      readonly threadId: ThreadId;
      readonly fallbackProjectId: ProjectId;
    };

export interface ProviderScopeCheck {
  readonly instanceId: ProviderInstanceId;
  readonly target: ProviderScopeCheckTarget;
}

export function collectProviderScopeChecks(
  command: OrchestrationCommand | ClientOrchestrationCommand,
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
      const turnTarget: ProviderScopeCheckTarget = createThread
        ? {
            kind: "thread-else-project",
            threadId: command.threadId,
            fallbackProjectId: createThread.projectId,
          }
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
          target: turnTarget,
        });
      }
      return checks;
    }
    default:
      return [];
  }
}

/**
 * Capabilities the validator needs, passed as values rather than resolved
 * from the Effect context so dispatch surfaces can reuse their existing
 * service handles without growing their handlers' context requirements.
 *
 * `getThreadProjectId` must resolve archived and soft-deleted threads too:
 * the decider still accepts commands against them, so a lookup that filters
 * inactive threads would let a bootstrap-bearing turn substitute an
 * arbitrary (more permissive) project for validation while the command
 * lands on the inactive thread's real project.
 */
export interface ValidateCommandProviderAccessDeps<E1 = never, E2 = never, E3 = never> {
  readonly getSettings: Effect.Effect<ServerSettings, E1>;
  readonly getThreadProjectId: (threadId: ThreadId) => Effect.Effect<Option.Option<ProjectId>, E2>;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, E3>;
}

export const validateCommandProviderAccess = Effect.fnUntraced(function* <E1, E2, E3>(
  command: OrchestrationCommand | ClientOrchestrationCommand,
  deps: ValidateCommandProviderAccessDeps<E1, E2, E3>,
) {
  const checks = collectProviderScopeChecks(command);
  if (checks.length === 0) return;
  const verificationFailure = (what: string) =>
    new OrchestrationDispatchCommandError({
      message: `Provider access could not be verified (${what} unavailable). Try again.`,
      // A read outage is not a policy denial: retry queues must keep the
      // command instead of discarding it as deterministically rejected.
      retryable: true,
    });
  const providerInstances = yield* deps.getSettings.pipe(
    Effect.map((settings) => settings.providerInstances),
    Effect.mapError(() => verificationFailure("server settings")),
  );

  for (const check of checks) {
    const target = check.target;
    const projectId =
      target.kind === "project"
        ? target.projectId
        : yield* deps.getThreadProjectId(target.threadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.map((threadProjectId) =>
              threadProjectId !== undefined
                ? threadProjectId
                : target.kind === "thread-else-project"
                  ? target.fallbackProjectId
                  : undefined,
            ),
            Effect.mapError(() => verificationFailure("thread state")),
          );
    // A cleanly missing thread without a bootstrap fallback is the
    // decider's error to report with proper context, not this gate's.
    if (projectId === undefined) continue;
    const project = yield* deps.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => verificationFailure("project state")),
    );
    if (project === undefined) continue;
    const restriction = getProviderInstanceProjectRestriction({
      instanceId: check.instanceId,
      instanceAllowedProjects: getProviderInstanceAllowedProjects(
        providerInstances,
        check.instanceId,
      ),
      projectId,
      projectAllowedProviderInstances: project.allowedProviderInstances ?? null,
    });
    if (restriction === "project-allowlist") {
      return yield* new OrchestrationDispatchCommandError({
        message: `Provider instance '${check.instanceId}' is not allowed for project '${project.title}'. Update the project's allowed providers in project settings, or pick another provider.`,
      });
    }
    if (restriction === "instance-scope") {
      return yield* new OrchestrationDispatchCommandError({
        message: `Provider instance '${check.instanceId}' is limited to other projects and cannot be used in project '${project.title}'. Widen its project scope in Settings → Providers, or pick another provider.`,
      });
    }
  }
});
