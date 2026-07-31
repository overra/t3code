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

Both editors require a server that advertises the `providerProjectScopes`
capability. Against an older server the editors are hidden (an older
server would silently ignore the fields), and existing scopes are
preserved server-side even when an older client re-sends provider
settings without them.

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

## Known limitations

Deliberate trade-offs in the current implementation:

- **Instance deletion vs. a concurrent stale edit.** Per-instance writes
  are granular upserts merged under the server's settings lock, but an
  upsert carries no "must already exist" expectation: a device editing an
  instance that another device deleted moments earlier recreates it. Since
  non-scope edits never carry the scope key (and the deleted server-side
  scope no longer exists to preserve), the recreated instance comes back
  UNRESTRICTED — even when the stale client had previously seen its scope
  — and stays that way until someone notices and corrects it. This is the
  one limitation that can widen access; closing it needs conditional
  create-vs-update mutations.
- **Pre-capability clients cannot delete restricted instances.** Whole-map
  writes from older clients retain any restricted instance they omit (the
  alternative silently converts "restricted" into "unrestricted default").
  Deleting a restricted instance requires a capability-aware client.
- **Task-creation retries after a lost acknowledgment.** A new-task
  bootstrap that succeeds but whose acknowledgment is lost cannot be
  replayed verbatim: the thread id is now occupied, so the retry surfaces
  as a rejection rather than deduplicating against the original. The web
  composer restores the content for resubmission; on mobile the queued
  task stays in the outbox marked **Failed**, and editing it re-queues
  under fresh identifiers. Worktree/branch cleanup after a mid-bootstrap
  failure is best-effort, not transactional.
- **Mobile offline queue.** A queued task or message rejected by policy is
  kept in place marked **Failed** — visible with its failure reason,
  editable (re-queued under fresh identifiers for creations), retryable,
  and deletable. A failed entry intentionally holds later messages queued
  behind it in the same thread, since delivering around it would reorder
  the conversation; choosing **Edit** dequeues it into the composer, which
  lets those later messages resume (confirmed first when any are waiting),
  and the edited message re-enters at the tail when sent. Deleting a
  thread discards its queued messages, failed ones included.
