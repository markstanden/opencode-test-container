# Staging and visibility

What a trial can see, in what order the workspace is built, and which subject
type reaches which mount. Get this wrong and the experiment measures the wrong
files — usually without saying so.

Path bases and construction order are owned by
[`docs/schema.md`](../schema.md) § Path bases. This page explains what those
stages mean for an author.

## Construction order

One case workspace is built once during `prepare`, then copied for each trial:

1. **Fixture.** `case.fixture` is resolved against the **suite document** and
   copied to the workspace root. Nothing is merged from the host repository.
2. **Inline files.** Each `case.files` key is written relative to the workspace
   root, after the fixture. A key that duplicates a fixture path **replaces**
   it; there is no refusal and no merge.
3. **Arm instructions.** Last, after the workspace copy exists. Instructions
   are files, not a merge, so a target that already exists is refused with:

    ```text
    instruction <id> collides with <as>
    ```

    The refusal happens while the trial is staged, before any container is
    dispatched. Inline `files` cannot resolve it: they are written before the
    instructions. For an arm-specific `AGENTS.md` comparison, keep that
    destination out of **both** the fixture and `case.files` and let each arm's
    instruction supply it. A common fixed `AGENTS.md` may live in the fixture or
    in `files` only when no arm instruction targets the same destination. A
    different filename avoids the filesystem collision, but OpenCode loads the
    project-context file it knows — do not assume an arbitrary name is read.

The prepared workspace is the pristine copy. Each trial gets its own writable
copy; edits made during a trial never leak into a later trial or into
`prepare/`.

## Where each subject type lands

An **arm** is a treatment. Its subjects are placed by type:

| Subject type             | Staged into                                    | Mount / visibility                                                 | Use it for                                        |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `skills[]`               | `<trial>/config-home/opencode/skills/<id>`     | `/config-home`, read-only, discoverable by the skill tool          | Description triggering and skill-body behaviour   |
| `plugins[]`              | `prepare/subjects/<arm>/plugins/<id>`          | `/subjects/plugins/<id>`, read-only, registered in `opencode.json` | Executable plugin code and its non-secret options |
| `instructions[]`         | `<trial>/workspace/<as>` (default `AGENTS.md`) | `/workspace`, writable, ordinary project context                   | Always-loaded guidance you are comparing          |
| case `fixture` + `files` | `<trial>/workspace/`                           | `/workspace`, writable                                             | The repository the task runs against              |

The config home carries a generated `opencode/opencode.json` with the campaign's
model, the arm's plugin entries (`package: "/subjects/plugins/<id>"` plus
`options`) and campaign `permissions`. It is **not** your user configuration,
and skill bundles are added beside it, never merged into a host catalogue.

Instructions are copied from the staged subject payload, so their bytes also
exist under `/subjects/instructions/<id>/<as>`; the copy the agent treats as
project context is the one in `/workspace`.

## Bundle-exposure choice

Ask what the trial must be able to _do_ before choosing a subject:

- **Measure the description → `skills[]`.** The skill is catalogued in
  `/config-home` under its declared `id`. Nothing in the workspace mentions it,
  so activation is a genuine choice.
- **Measure always-loaded guidance → `instructions[]`.** The file arrives as
  project context. This is the only way the agent sees a pointer line or an
  `AGENTS.md` the way a real session would.
- **Measure plugin behaviour → `plugins[]`.** Use `include` to stage only the
  package members the runtime needs, and `options` for non-secret settings.
- **Measure work in a realistic repository → `fixture` (plus `files`).** The
  workspace is the only writable surface, so this is also where an expected
  edit can happen.

An arm may combine them; a before/after guidance comparison usually stages the
same skill as `skills[]` in both arms and differs only in `instructions[]`.

## What the trial cannot see

- The host home is not mounted. `HOME` is `/tmp/agent-home`; `XDG_CONFIG_HOME`
  points at the generated per-trial config home. Your live `~/.config/opencode`
  never leaks in, in either direction.
- The suite, campaign, truth, criteria, other arms and the evidence root are
  outside the model-visible filesystem. `truth` is judge context and is never
  written into a workspace.
- Absolute host paths are not reachable. A skill that says "read
  `~/.config/opencode/UNIT_TESTS.md`" finds nothing in a trial; stage a copy as
  an instruction or a case file when that read is part of the treatment.
- The network is whatever `runtime.network` declares. `host` is honest host
  networking, not provider-only egress.
- A docs case gets one extra writable mount for the signed operation journal.
  Skill cases get none.

Provider routing is not a file: `runtime.provider.overlay` is passed as
`OPENCODE_CONFIG_CONTENT`, and credential values are copied by **name** from
the caller's environment into a `0600` trial env file. The campaign declares
`passthroughEnv` names, never values.

## Pre-dispatch sanity check

Four locations are easy to confuse. Inspect each one where it actually exists:

| Stage                   | Path                                         | What it holds                                                  |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Prepared case workspace | `<root>/prepare/workspaces/<caseId>/`        | fixture and inline `files`, shared by every repetition         |
| Staged arm subject      | `<root>/prepare/subjects/<arm>/`             | skills, plugins and instruction payloads                       |
| Dry-run payload         | a temporary directory                        | one plan's trial copy, removed as soon as the plan is built    |
| Trial workspace         | `<root>/evidence/trials/<slotId>/workspace/` | a fresh copy of the case workspace plus the arm's instructions |

The order that matches those preconditions:

1. `otc prepare` succeeds. Open the case workspace and confirm the fixture files
   you expect; inline `files` have already been applied over them.
2. Read each arm's instruction bytes under
   `<root>/prepare/subjects/<arm>/instructions/<id>/<as>`.
3. `otc freeze` records the image and CLI identity. Dry-run needs it.
4. `otc run --dry-run` stages each selected slot in a disposable directory and
   reports any `instruction <id> collides with <as>`; it consumes no trial
   budget, starts no container and makes no provider request. It prints no
   mounts or argv and keeps no directory, so confirm those against
   [`docs/schema.md`](../schema.md) and the campaign.
5. Dispatch, then inspect `<root>/evidence/trials/<slotId>/workspace/` to see
   what the trial really received.

If the answer to a prompt depends on a file, verify the file is on a writable
or read-only mount the trial actually has. "The agent ignored it" is usually
"it was never there".

If a check fails, change the source documents and prepare a fresh root. Never
edit a prepared, frozen or evidence tree to repair an experiment — that tree is
the record of what ran.

## Next

- The worked activation suite:
  [`add-installer-recipe.md`](add-installer-recipe.md).
- Runnable configurations with expected evidence: [`recipes/`](recipes/).
- Pre-flight and post-run checks: [`agent-checklist.md`](agent-checklist.md).
