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
| campaign      | 1       | explicit slots, runtime, budgets, assessment                          |
| manifest      | 1       | embedded suite and normalised campaign; no source absolute paths      |
| freeze        | 1       | `kind: "otc-freeze"`, immutable IDs, tool identity and `freezeSha256` |
| assessment    | 1       | skill or docs shape; deterministic `attemptId`                        |
| primary check | 1       | product checker identity, fixed interpreter and outcome               |
| judgement     | 1       | arm-blind judge verdict and its failure class                         |
| selection     | 1       | per-slot chosen attempt and every attempt fact                        |
| report        | 1       | derived, `reportSha256` over content                                  |
| ledger event  | 1       | trial, primary-check, assessment, judge and close events              |

`docs-task` cases may also carry `truth` (arm-blind judge context) and`primaryCheck: { id, directory, script, timeoutMs? }`. The checker directory
is staged under `prepare/primary-checks/<caseId>`; the fixed contract is
`node /checker/<script> /live /pristine`. It is never mounted into the trial.

A campaign `assessment` may carry `judge: { model, timeoutMs? }` and
`recovery` (the narrow registration in `analysis/recovery.ts`). Judge and
recovery budgets count dispatches, not HTTP requests; `providerRequestLimit`
stays `null` unless an adapter exposes a real request count.

The prepared manifest and freeze receipt also carry
`tool: { name, version, evaluatorVersion }`, read from the installed package
metadata. This makes the compiled artifact, the source identity and the frozen
evaluator semantics traceable without a Git checkout.

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
- Judge failure classes: `json-syntax`, `schema`, `semantic`,
  `empty-or-truncated`, `transport-or-process`. Only a complete `json-syntax`
  failure is recoverable, once, from identical packet bytes.
- A judge attempt is a durable dispatch, not an HTTP request; request counts
  are reported separately when the adapter exposes them.
