/**
 * "Projects" row for a provider instance card: summary trigger + popover
 * editing the envelope's `allowedProjects` scope.
 *
 * The mode is explicit, never inferred from the checklist:
 *
 *   - "All projects" stores `null` — usable everywhere, including projects
 *     created later.
 *   - "Selected projects" stores an explicit project-id list. Checking every
 *     current project keeps the explicit list; it never silently widens back
 *     to "all", so an instance scoped as an account boundary (e.g. a work
 *     provider) can never leak into a project created tomorrow.
 *
 * Switching to "Selected projects" seeds the list with every current project
 * so the user narrows from a safe starting point. The last selected project
 * cannot be unchecked — "usable nowhere" is what the enabled switch
 * expresses, and the schema rejects an empty list.
 *
 * Before a narrowed scope is saved the section cross-checks every project's
 * *effective* provider set (this instance's candidate scope intersected with
 * each peer instance's scope and the project's own allowlist) and calls out
 * projects that would be left with no usable provider at all.
 */
import { useMemo } from "react";
import type { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { isProviderInstanceUsableInProject } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { cn } from "~/lib/utils";

export interface ProviderScopeProjectOption {
  readonly id: ProjectId;
  readonly title: string;
  readonly allowedProviderInstances: ReadonlyArray<ProviderInstanceId> | null;
}

export interface ProviderScopePeerInstance {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly allowedProjects: ReadonlyArray<ProjectId> | null;
}

function strandedProjectTitles(input: {
  readonly instanceId: ProviderInstanceId;
  readonly candidateScope: ReadonlyArray<ProjectId> | null;
  readonly projects: ReadonlyArray<ProviderScopeProjectOption>;
  readonly peerInstances: ReadonlyArray<ProviderScopePeerInstance>;
}): ReadonlyArray<string> {
  const titles: string[] = [];
  for (const project of input.projects) {
    const hasUsableProvider = input.peerInstances.some((peer) => {
      if (!peer.enabled) return false;
      const scope =
        peer.instanceId === input.instanceId ? input.candidateScope : peer.allowedProjects;
      return isProviderInstanceUsableInProject({
        instanceId: peer.instanceId,
        instanceAllowedProjects: scope,
        projectId: project.id,
        projectAllowedProviderInstances: project.allowedProviderInstances,
      });
    });
    if (!hasUsableProvider) {
      titles.push(project.title);
    }
  }
  return titles;
}

export function ProviderProjectScopeSection(props: {
  displayName: string;
  allowedProjects: ReadonlyArray<ProjectId> | null;
  projects: ReadonlyArray<ProviderScopeProjectOption>;
  instanceId: ProviderInstanceId;
  peerInstances: ReadonlyArray<ProviderScopePeerInstance>;
  onChange: (allowedProjects: ReadonlyArray<ProjectId> | null) => void;
}) {
  const { allowedProjects, projects, onChange } = props;
  const mode: "all" | "selected" = allowedProjects === null ? "all" : "selected";
  const checkedIds = useMemo(() => new Set<ProjectId>(allowedProjects ?? []), [allowedProjects]);
  const checkedProjectCount = projects.filter((project) => checkedIds.has(project.id)).length;
  const summary =
    mode === "all"
      ? "All projects"
      : `${checkedProjectCount} of ${projects.length} project${projects.length === 1 ? "" : "s"}`;

  const stranded = useMemo(
    () =>
      strandedProjectTitles({
        instanceId: props.instanceId,
        candidateScope: allowedProjects,
        projects,
        peerInstances: props.peerInstances,
      }),
    [allowedProjects, projects, props.instanceId, props.peerInstances],
  );

  const setMode = (nextMode: "all" | "selected") => {
    if (nextMode === mode) return;
    if (nextMode === "all") {
      onChange(null);
      return;
    }
    // Seed with every current project: narrowing starts from a state that
    // changes nothing, and the user unchecks from there.
    if (projects.length === 0) return;
    onChange(projects.map((project) => project.id));
  };

  const toggle = (projectId: ProjectId, checked: boolean) => {
    const next = new Set(checkedIds);
    if (checked) {
      next.add(projectId);
    } else {
      next.delete(projectId);
    }
    if (!projects.some((project) => next.has(project.id))) {
      return;
    }
    // Deliberately no collapse to `null` when everything is checked: the
    // user chose an explicit list, and future projects must stay outside it
    // until added by hand.
    onChange([...next]);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-medium text-foreground">Projects</span>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {mode === "all"
              ? `${props.displayName} can be used in every project, including projects added later.`
              : `${props.displayName} can only be used in the selected projects. New projects are not added automatically.`}
          </p>
        </div>
        <Popover>
          <PopoverTrigger
            render={<Button type="button" size="sm" variant="outline" className="shrink-0" />}
          >
            {summary}
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-80 p-0">
            <RadioGroup
              value={mode}
              onValueChange={(value) => {
                if (value === "all" || value === "selected") setMode(value);
              }}
              aria-label={`Project scope mode for ${props.displayName}`}
              className={cn("gap-0 p-1.5", mode === "selected" && "border-b border-border/70")}
            >
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
                <Radio value="all" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">All projects</span>
                  <span className="block text-xs text-muted-foreground">
                    Including projects added later.
                  </span>
                </span>
              </label>
              <label
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40 has-data-disabled:cursor-default has-data-disabled:opacity-60"
                title={projects.length === 0 ? "No projects in this environment yet." : undefined}
              >
                <Radio value="selected" className="mt-0.5" disabled={projects.length === 0} />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">Only selected projects</span>
                  <span className="block text-xs text-muted-foreground">
                    New projects are not added automatically.
                  </span>
                </span>
              </label>
            </RadioGroup>
            {mode === "selected" ? (
              <div className="max-h-64 overflow-y-auto p-1.5">
                {projects.map((project) => {
                  const isChecked = checkedIds.has(project.id);
                  const isLastChecked = isChecked && checkedProjectCount === 1;
                  return (
                    <label
                      key={project.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40"
                      title={
                        isLastChecked
                          ? `At least one project must stay selected. To keep ${props.displayName} out of every project, disable it instead.`
                          : project.title
                      }
                    >
                      <Checkbox
                        checked={isChecked}
                        disabled={isLastChecked}
                        onCheckedChange={(checked) => toggle(project.id, checked === true)}
                        aria-label={`Allow ${props.displayName} in ${project.title}`}
                      />
                      <span className="min-w-0 truncate text-sm">{project.title}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
            {stranded.length > 0 ? (
              <div className="flex items-start gap-2 border-t border-border/70 px-3 py-2">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <p className="text-xs leading-snug text-muted-foreground">
                  {stranded.length === 1
                    ? `"${stranded[0]}" has no usable provider left`
                    : `${stranded.length} projects have no usable provider left (${stranded.join(", ")})`}
                  . Threads there cannot start until a provider is allowed again.
                </p>
              </div>
            ) : null}
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
}
