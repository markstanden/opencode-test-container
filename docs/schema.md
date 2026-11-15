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

| Document     | Version | Notes                                                             |
| ------------ | ------- | ----------------------------------------------------------------- |
| suite        | 1       | discriminated `skill-trigger` / `docs-task`; no executable fields |
| campaign     | 1       | explicit slots, runtime, budgets, assessment                      |
| manifest     | 1       | embedded suite and normalised campaign; no source absolute paths  |
| freeze       | 1       | `kind: "otc-freeze"`, immutable IDs and `freezeSha256`            |
| assessment   | 1       | skill or docs shape; deterministic `attemptId`                    |
| report       | 1       | derived, `reportSha256` over content                              |
| ledger event | 1       | `trial-start`, `trial-end`, `assessment`, `close`                 |

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
- A judge HTTP retry is not a durable attempt; request counts are reported
  separately where known, and provider-request ceilings remain unknown unless
  implemented and proved.
