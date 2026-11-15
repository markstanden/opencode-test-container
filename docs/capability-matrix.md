# Diagnosis capability matrix

Status at the reconciliation head. "Parity" means the same recorded evidence
produced identical structured analysis; permitted differences are listed
separately.

| Capability                         | Original implementation                                      | OTC implementation                                                                               | Tests                                                                             | Offline parity evidence                                                                 | Remaining owner                                               |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Preparation / materialisation      | docs `harness.mts`, `prod014` materialise                    | `src/campaign/prepare.ts` (new campaigns)                                                        | OTC lifecycle/prepare/freeze tests                                                | not applicable (dispatch-side)                                                          | Docs legacy for frozen prod014 roots; OTC for new campaigns   |
| Recording credit / journal         | docs `analysis/journal.ts`                                   | `src/evaluators/docs/journal.ts`                                                                 | OTC docs assessment tests + ported analysis tests                                 | mini + confirmation + screening exact                                                   | none                                                          |
| Utility / opportunity counts       | docs `analysis/{accounting,measures}.ts`                     | same modules under `src/evaluators/docs/analysis`                                                | ported analysis aggregation/measures, decision-authority                          | mini utility totals (10/10, 20/20), screening 24/24                                     | none                                                          |
| Retrieval measures                 | docs `analysis/measures.ts`, `records.ts`                    | same                                                                                             | ported measures suite + `measures-gaps` (path/lake/contradiction)                 | recorded campaigns declare no measurement spec; synthetic/contract coverage only        | OTC; real-declaration parity needs a campaign with `measures` |
| Preservation                       | docs `analysis/{scoring,measures,guardrails}.ts`             | same                                                                                             | ported measures/guardrails/screening tests                                        | mini R02 preservation and screening findings exact                                      | none                                                          |
| Guardrails                         | docs `analysis/guardrails.ts`                                | same                                                                                             | ported decision/guardrails tests                                                  | mini both guardrails clean; screening exact                                             | none                                                          |
| Pairing / bounds                   | docs `analysis/{pairing,bounds}.ts`                          | same                                                                                             | ported aggregation/decision tests                                                 | mini 2 complete pairs, delta 0 [0,0]; confirmation bounds exact                         | none                                                          |
| Screening                          | docs `analysis/screening/*`                                  | same                                                                                             | ported screening suite (rules/inventory/scan/reconcile)                           | screening campaign `SCREENING.json` byte-identical                                      | none                                                          |
| Judge output classification        | docs `ac-scoring.mts`                                        | `src/evaluators/docs/scoring.ts` (`judgeFailureClass`, parse/validate) + `src/campaign/judge.ts` | ported ac-scoring + judge-recovery-policy + OTC judge tests                       | fresh scripted judge lifecycle; classification/recovery pure contracts exact            | none                                                          |
| Judge recovery                     | docs `analysis/recovery.ts`, `analysis/budget.ts`            | same + OTC judge dispatch                                                                        | ported judge-recovery-policy (28 tests, concurrent ceilings) + OTC recovery tests | fresh scripted malformed-then-valid judge; selection attempt-002                        | none                                                          |
| Primary checks / corpus generation | docs harness and `primary-checks/`                           | OTC stages and executes supplied checkers; docs owns case data, truth and checker bytes          | OTC primary tests + fresh rehearsal                                               | fresh checker pass/fail/timeout; checker never in trial payload                         | Docs product corpus ownership                                 |
| Budgets                            | docs `analysis/{budget,closure}.ts` + campaign ledger        | migrated analysis budget/closure + OTC campaign ledger                                           | ported closure/launch-boundary + OTC lifecycle budget tests                       | exact analysis accounting/ledger sections                                               | none                                                          |
| Selection                          | docs `analysis/selector.ts`, `recovery.ts`                   | same                                                                                             | ported recovery/selection tests                                                   | exact `assessmentSelection` in parity outputs                                           | none                                                          |
| Closure                            | docs `analysis/closure.ts` + `close-campaign.mts`            | migrated closure + `otc close`                                                                   | ported closure tests + OTC close idempotence                                      | transaction/ledger state exact                                                          | none                                                          |
| Reporting                          | docs `analysis/{render,measures,decision}.ts`, `analyse.mts` | migrated render/measures/decision + `otc replay`, OTC campaign report                            | ported report/integrity + OTC report tests                                        | `analysis.json`, `REPORT.md`, `SCREENING.json` exact; receipt only `renderedAt` differs | none for recorded replay; OTC campaign report separate        |
| Status                             | docs `prod014/status.mts`                                    | `src/campaign/status.ts`                                                                         | OTC CLI/status tests                                                              | not applicable (new roots)                                                              | Docs legacy for frozen roots                                  |
| Container / process adapters       | docs `Containerfile`, `container-run.sh`                     | `container/Containerfile`, `src/adapters/podman`                                                 | OTC adapter tests + real rehearsal                                                | real Podman/OpenCode rehearsal                                                          | none                                                          |
| Skill activation                   | none                                                         | `src/evaluators/skills`                                                                          | OTC skill tests + real scripted rehearsal                                         | real adapter rehearsal                                                                  | none                                                          |

## Fresh lifecycle capability

The migrated `harness/run.ts` CLI is removed. No OTC source can spawn the docs
repository's old `tests/fixtures/placement-harness/harness.mts`; only
product-supplied suite, truth and checker bytes remain external data. A
campaign can now execute the complete path without the docs repository's old
harness:

| Stage                    | OTC implementation                                | Evidence                                                        |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------- |
| Validate / prepare       | `contracts/validate.ts`, `campaign/prepare.ts`    | unit + CLI tests; staged immutably                              |
| Delivery / freeze        | `campaign/freeze.ts`                              | image ID, suite, subjects, workspaces, prompts and checkers     |
| Trial dispatch           | `campaign/run.ts`, `adapters/{opencode,podman}`   | real Podman/OpenCode rehearsal; dry-run plan                    |
| Product primary check    | `campaign/primary.ts`                             | separate no-network container; pass/fail/timeout/error recorded |
| Deterministic assessment | `evaluators/{docs,skills}`                        | primary outcome folded into the docs criterion                  |
| Blind judge              | `campaign/judge.ts`, `evaluators/docs/scoring.ts` | neutral packet; established parse/validate/failure classes      |
| Bounded recovery         | `analysis/recovery.ts`, `analysis/budget.ts`      | one `json-syntax` retry, identical packet, durable claims       |
| Validated selection      | `analysis/selector.ts`, `campaign/judge.ts`       | per-slot selection record checked against attempts              |
| Closure / analysis       | `campaign/close.ts`, `reporting/report.ts`        | pending judgement and unsettled claims block closure            |
| Status                   | `campaign/status.ts`                              | read-only counts, judgement and next actions                    |

## Semantic parity runs

All runs replay recorded evidence offline; no model call was made.

| Corpus                                               | Trials | Original vs OTC                                                                                      |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| committed mini replay (`tests/fixtures/docs-parity`) | 4      | `analysis.json`, `REPORT.md`, `SCREENING.json` deep-equal; receipt equal after removing `renderedAt` |
| recorded confirmation (`recording-confirm-20261110`) | 40     | all three artefacts byte-identical; receipt only `renderedAt`                                        |
| recorded screening (`docs-desc-fresh-20261110`)      | 48     | all three artefacts byte-identical                                                                   |

The committed parity test exercises the mini corpus in `npm test`. The two
larger corpora were replayed manually because they total ~56 MB and are not
committed. The frozen published `ANALYSIS-confirmation.json` uses an older
schema and was not treated as a byte target; the comparison is between the
original analyser at the extraction base and the OTC port on the same evidence.

## Permitted differences

- `renderedAt` in `analysis-receipt.json` (wall-clock).
- Absolute evidence/manifest paths when a caller supplies a different root.
- OTC campaign reports (`analysis`/`report`) use the new lifecycle schema; they
  are not claimed to be byte-compatible with docs analysis reports.
