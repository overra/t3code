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
the CLI covers the same policy everywhere:

```sh
t3 project providers <project-id-or-path>                 # show the allowlist
t3 project providers <project> --allow codex,claude_work  # restrict
t3 project providers <project> --all                      # clear the restriction
```
