# Per-project provider access

Restrict which provider instances a project may use — for example, keep a
work Claude account out of personal repositories, and personal accounts out
of work repositories. Two optional rules compose; each defaults to
unrestricted, and a provider is usable in a project only when **both**
admit it:

- **Project allowlist** — in the sidebar, open a project's settings
  (project row → Project settings) and check the providers the project may
  use. All-checked means every provider, including ones added later.
- **Provider project scope** — in Settings → Providers, expand a provider
  and use its **Projects** control: "All projects" or an explicit list.
  An explicit list never widens on its own; new projects must be added by
  hand, so an account scoped as a boundary stays a boundary.

Both rules are enforced server-side for every turn — including background
work such as thread titles, branch names, and commit/PR message generation
— not just in the model picker. The picker lists providers hidden by a
rule under "Not available in this project" with the rule that hid each
one.

## From the terminal

Builds using the classic sidebar do not have the project-settings editor;
the CLI covers the same policy everywhere. `<project>` is a project id or
its workspace path — from inside the project, `.` works:

```sh
npx t3@latest project providers .                                 # show the allowlist
npx t3@latest project providers . --allow codex,claudeAgent_work  # restrict
npx t3@latest project providers . --all                           # clear the restriction
```

The flagless form only prints the current allowlist — changing it always
takes `--allow` or `--all`. The `--allow` list takes provider _instance_
ids: the driver name for a default instance (`codex`, `claudeAgent`), or
the name chosen when an extra instance was added (for example
`claudeAgent_work`). Every configured instance id is visible in
Settings → Providers.
