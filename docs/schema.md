# Schema and migration table

## Glossary

- **suite** — reusable case definitions plus one assessment kind.
- **case** — one prompt/context and its expected behaviour.
- **campaign** — one frozen scheduled execution.
- **arm** — one treatment configuration.
- **slot** — one case × arm × repetition.
- **trial** — execution of a slot.
- **assessment** — deterministic or model-based evaluation.
- **judge attempt** — one separately accounted model assessment dispatch.
- **report** — derived output outside immutable evidence.

Canonical fields: `caseId`, `campaignId`, `armId`, `slotId`, `repetitionId`,
`attemptId`. `repetitionId` is an opaque string; the legacy numeric repetition
is rendered as `r<N>` only at the adapter boundary.

## Versioned documents

| Document      | Version | Notes                                                                 |
| ------------- | ------- | --------------------------------------------------------------------- |
| suite         | 1       | discriminated `skill-trigger` / `docs-task`; no executable fields     |
| campaign      | 1       | explicit slots, runtime, budgets, assessment, optional stop policy    |
| manifest      | 1       | embedded suite and normalised campaign; no source absolute paths      |
| freeze        | 1       | `kind: "otc-freeze"`, immutable IDs, tool identity and `freezeSha256` |
| assessment    | 1       | skill or docs shape; evaluator version and source-evidence binding    |
| primary check | 1       | product checker identity, fixed interpreter and outcome               |
| judgement     | 1       | arm-blind judge verdict and its failure class                         |
| selection     | 1       | per-slot chosen attempt and every attempt fact                        |
| report        | 1       | derived, `reportSha256` over content                                  |
| ledger event  | 1       | trial, primary-check, assessment, judge and close events              |

`docs-task` cases may also carry `truth` (arm-blind judge context) and `primaryCheck: { id, directory, script, timeoutMs? }`. The checker directory
is staged under `prepare/primary-checks/<caseId>`; the fixed contract is
`node /checker/<script> /live /pristine`. It is never mounted into the trial.
A `skill-trigger` case has no primary check: the validator rejects
`primaryCheck` there rather than ignoring it.

## Path bases

Relative paths resolve against different documents by field; there is no
single "campaign-relative" rule.

| Field                                                            | Resolves against                         |
| ---------------------------------------------------------------- | ---------------------------------------- |
| `suite.path`                                                     | the campaign document                    |
| subject `skills[].path`, `plugins[].path`, `instructions[].path` | the campaign document                    |
| case `fixture`                                                   | the suite document                       |
| `primaryCheck.directory`                                         | the suite document                       |
| case `files` keys                                                | the trial workspace root                 |
| instruction `as`                                                 | a destination inside the trial workspace |

Trial workspace construction order is fixture, then inline `files`, then arm
instructions. Instructions are copied last and a target that already exists is
refused with `instruction <id> collides with <as>`. A fixture that ships
`AGENTS.md` cannot be overridden by an instruction targeting `AGENTS.md`; make
the workspace copy a `files` entry or leave it out of the fixture.

A campaign `assessment` may carry `judge: { model, timeoutMs? }` and
`recovery` (the narrow registration in `analysis/recovery.ts`). Judge and
recovery budgets count dispatches, not HTTP requests; `providerRequestLimit`
stays `null` unless an adapter exposes a real request count.

The prepared manifest and freeze receipt also carry
`tool: { name, version, evaluatorVersion, artifactSha256 }`. The artifact hash
covers the executing runtime tree and package manifest, derived from the
executing module's own `src`/`dist` location, so source execution beside a
build and installed JavaScript execution each fingerprint the right tree. `run`, `judge`, `delivery-check` and
`status` compare the executing identity with the frozen identity before
dispatch; read-only historical replay does not require it.

Trial, judge and recovery claims live only under
`<root>/evidence/{trial,judge,recovery}`. A recovery settles both of its claims
according to the dispatch outcome; an interrupted dispatch keeps the claim
`spawned` and closure refuses it. Status counts `judged`, `pending`, `failed`,
`invalid` and `unsettled` from the same checked state.

## Checked evidence

Persisted evidence is loaded through `src/evidence`, never by `JSON.parse` at a
consumer. The checked states are `missing`, `valid`, `corrupt`, `unsupported`
and `conflicting`.

- **Capture** validity is derived from the raw `events.jsonl` stream and the
  supported OpenCode event contract, then reconciled with `meta.json`: counters,
  answer hash, exit, timeout, error and byte overflow must agree. A metadata
  flag is a claim, never proof. Invalid or unknown captures are never a passing
  restraint or activation.
- **Assessments** must match the scheduled slot, schema and evaluator version,
  the exact source-evidence hashes they recorded, and one authoritative
  `assessment` ledger event with the same SHA-256, outcome and validity. The
  binding covers the raw capture, metadata, tools, answer, primary-check
  record, docs journal and key, and the evaluated workspace identity (path,
  kind, link target and bytes). An unexpected record file, duplicate binding or
  any changed or deleted input is a conflicting assessment.
- **Local limit.** These hashes detect an edited record, missing binding or
  changed evidence. They cannot defeat an operator who coherently rewrites every
  trusted record on the machine.

Assessments carry `evaluatorVersion` (currently 2). Version 1 roots are
read-only replay material; they are accepted only when their hashes bind and
are never rewritten.

Genuine v0.1.1 records predate both `evaluatorVersion` and `evidence`. They are
read through an explicit legacy path: identity, payload and the old ledger hash
are still checked, but no source binding is invented. The checked reader marks
them `historical` with the limitation that later evidence changes are not
detectable. The original bytes and ledger hashes are never rewritten; a genuine
fixture from the reviewed implementation is kept under
`tests/fixtures/assessment-v0.1.1/`.

## Admission and closure

Dispatch admission, assessment publication and campaign closure share one
exclusive lock at `<root>/evidence/ADMISSION.lock`. Admission re-reads the
ledger and publishes its durable claim inside the critical section; closure
re-reads the ledger/claims and appends the close event inside the same section.
Whichever wins, the other observes it: a post-close dispatch cannot start, and
a close cannot slip between a dispatch's state check and its claim. The lock is
held only for the short decision/publication window, never across a running
container. A lock is **never** deleted by another process. A live holder is waited for and
then refused; a stale lock after a hard crash also fails closed until an
operator verifies the recorded owner is gone and removes that exact path.
Automatic stale recovery has a check-then-unlink race that can admit two
owners, so it is not offered. `admissionLockStatus` and `otc status` report a
held lock and its recorded pid. A second unprotected state check is never the
authority.

## Lifecycle and reservations

Trial, judge and recovery spend use durable claim files created with `wx`
under `<root>/evidence/<kind>/`. The filesystem is the arbitration point, so
two processes cannot both take the last allowance, and two processes cannot
claim the same slot key. A claim counts from `reserved` onward:
`reserved → spawned → closed`. A crash keeps the claim, so an ambiguous attempt
is never silently refunded. Only a claim that provably never staged or
dispatched is released.

Closure is the final mutation boundary. It refuses unresolved trial launches,
any non-closed claim, untrustworthy assessments, and completed trials with no
checked assessment. A never-started slot is legitimate `unrun` state and may be
closed over. Post-close assessment is a read-only view of checked records; a
request needing new evidence is refused.

## Stop policy

`stopOnFirstFailure` enables stopping; `stopPolicy: { version: 2 }` declares the
semantics. Absent means legacy version 1.

| Stage  | Version 2 stops after                                                   | Version 1 stops after            |
| ------ | ----------------------------------------------------------------------- | -------------------------------- |
| run    | invalid capture, non-zero exit, or a declared non-passing primary check | invalid capture or non-zero exit |
| assess | a deterministic fail or invalid                                         | never                            |
| judge  | a valid adverse verdict, or an operational refusal/error                | any recorded problem             |

Already-running work is accounted for; no stage cancels a completed trial.

## Containment and publication

Contained file reads classify the object before opening and open with
`O_NONBLOCK`, so a FIFO or a replacement FIFO is refused rather than blocking.

Workspace and lake content is read only through `src/evidence/containment.ts`:
a real directory root, no symlinked directory traversal, containment of every
resolved target, `O_NOFOLLOW` on the final open, and controlled refusal of
FIFOs and special files. An invalid inventory or escaping object blocks packet
and assessment construction instead of becoming “no changes”.

Reports must resolve outside `evidence/` and `prepare/`; existing ancestors and
symlinked parents are resolved before anything is created. Output is staged in
a sibling temporary directory and renamed, so a failed publication leaves no
misleading completed report.

Primary-checker containers use the same ownership as trials and judges: an
owned name, ownership labels, the attempt's cancellation signal, bounded
timeout cleanup, and removal of the checker env file on every path.

Environment files accept only portable names, reject newline/CR/NUL values, and
never override OTC-owned `HOME`, `XDG_*`, `OPENCODE_CONFIG_CONTENT` or
`DOCS_OPERATION_JOURNAL*`. Mount sources and targets may not contain commas or
NULs. Containers carry an owned unique name and labels; cleanup addresses that
name only.

Assessment publication is atomic: the record is linked into place and exactly
one ledger binding is created under an exclusive per-slot binding lock. A
leftover lock after a crash is a controlled refusal, never an invitation to
re-bind or delete evidence.

A selection is trusted only through the shared checked reader: attempt set,
packet bytes, policy hash, selected judgement SHA-256, outcome/utility and the
judged documentation state are re-derived. The slot and attempt `packet.md`
bytes are hashed and compared with the registered identity, with each other,
and with the packet reconstructed from current evidence. A readable object
alone is never a judgement and never permits closure; missing, changed or
mismatched packets and metadata are explicit integrity diagnostics in judge,
status, closure and report. Metadata-reading problems from every attempt are
retained even when other attempts remain readable, so an earlier terminal
failure never masks an inconsistent later recovery.

## New/legacy names

| Legacy                  | New                              | Handling                                        |
| ----------------------- | -------------------------------- | ----------------------------------------------- |
| `scenario`              | `caseId`                         | mapped by `legacy/prod014.ts`; old id unchanged |
| `stamp`                 | `slotId`                         | the frozen stamp becomes the slot id, unchanged |
| numeric `repetition`    | `repetitionId`                   | `r<N>` at the adapter boundary                  |
| `pairId`                | `pairId` (legacy metadata)       | retained on `LegacySlot`                        |
| `arm` A/B               | `armId`                          | retained, no implicit pair policy               |
| `PLACEMENT_*`           | `OTC_*` or typed manifest fields | new code only; no silent alias                  |
| `AC_*`                  | typed manifest fields            | new code only                                   |
| `docs-operations.jsonl` | unchanged                        | genuine plugin interface                        |
| `OPENCODE_*`            | unchanged                        | genuine upstream interface                      |

Conflicting legacy/new environment aliases are not accepted. Frozen evidence
and historical `.mjs` files are never rewritten by a rename.

## Outcome states

- validity: `valid`, `invalid`, `unknown`, `unrun`.
- outcome: `pass`, `fail`, `unknown`.
- A missing capture or failed target load is `unknown`/`invalid`, never pass.
- Docs refused writes retain zero recording credit; attempts are reported.
- A primary checker that fails makes the criterion fail; a timeout or spawn
  error is `unknown`; a declared checker with no result is `invalid`.
- Usage coverage is explicit per field: no step-finish event is `unknown`,
  an incomplete token block is `partial`, and an explicit zero is `measured`.
  Unknown usage is never reported as a measured zero.
- Judge failure classes: `json-syntax`, `schema`, `semantic`,
  `empty-or-truncated`, `transport-or-process`. Only a complete `json-syntax`
  failure is recoverable, once, from identical packet bytes.
- A judge attempt is a durable dispatch, not an HTTP request; request counts
  are reported separately when the adapter exposes them.
