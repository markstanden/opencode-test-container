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
    dispatched. A fixture that ships `AGENTS.md` therefore cannot be overridden
    by an instruction targeting `AGENTS.md`: supersede it in `case.files`, or
    leave it out of the fixture.

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

Before spending a trial:

1. `otc prepare` succeeds and the case workspace under
   `<root>/prepare/workspaces/<caseId>/` contains the fixture files you expect.
2. Every instruction path exists in the workspace and no collision was
   reported.
3. `otc run --dry-run` builds each selected slot's plan and lists the slots it
   would dispatch; it prints no mounts or argv, so confirm those against
   [`docs/schema.md`](../schema.md) and the campaign.

If the answer to a prompt depends on a file, verify the file is on a writable
or read-only mount the trial actually has. "The agent ignored it" is usually
"it was never there".

## Next

- The worked activation suite:
  [`add-installer-recipe.md`](add-installer-recipe.md).
- Runnable configurations with expected evidence: [`recipes/`](recipes/).
- Pre-flight and post-run checks: [`agent-checklist.md`](agent-checklist.md).
