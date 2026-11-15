# Trial analysis: mini-20261111
**Personal-trial screen:** not applicable — the measurement declaration is missing; only the utility threshold is available.
**Utility threshold (component, not the recommendation):** not-qualified — lead 0; full-population interval 0..0 vs threshold 5.
Question: does the analyser replay a small recorded campaign?
## Frozen setup

| Item | Value |
| --- | --- |
| Manifest SHA-256 | 5513661b0e4f66b030c1fd22920c0147209a8371720c520652dc7026069c3931 |
| Evidence layout | ac-v1 |
| Judgement selection policy | resolution-then-judgement |
| Policy identity | mini-policy-v1 |
| Weights | useful 5, transient -1, duplicate -2, misleading -5, taskFailure -5 |
| Selection rule | control A, candidate B, threshold 5, complete coverage true |
| Guardrails | mutation-policy (mutation-policy); destructive-loss (destructive-loss) |

## Accounting

| Arm | Planned | Recorded | Completed | Documented | Scored | Gate pass/blocked | Primary P/F/U | Utility | Interval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 2 | 2 | 2 | 2 | 2 | 2/0 | 2/0/0 | 10 | 10..10 |
| B | 2 | 2 | 2 | 2 | 2 | 2/0 | 2/0/0 | 10 | 10..10 |

Intervals are worst-case missing-data bounds, not confidence intervals.

| Arm | useful-create | useful-update | transient | duplicate | misleading | none |
| --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 1 | 0 | 0 | 0 | 0 |
| B | 1 | 1 | 0 | 0 | 0 | 0 |

## Opportunity measures

Declaration: missing.

| Arm | Recording | Recording unknown | Recording not run | Retrieval | Retrieval unknown | Retrieval not run |
| --- | --- | --- | --- | --- | --- | --- |

### Eligible trials

| Stamp | Scenario | Arm | Recording | Retrieval | Evidence |
| --- | --- | --- | --- | --- | --- |

### Personal-trial screen

Recommendation: **inconclusive**.

- no measurement declaration is declared in the manifest

Utility threshold (one component, not the recommendation): fail; lead 0; interval 0..0. One component only: a zero-delta 'qualified' at threshold 0 is not the personal-trial recommendation.

## Per scenario

| Arm | Scenario | Planned | Documented | Scored | Gate P/B | Utility |
| --- | --- | --- | --- | --- | --- | --- |
| A | R01 | 1 | 1 | 1 | 1/0 | 5 |
| A | R02 | 1 | 1 | 1 | 1/0 | 5 |
| B | R01 | 1 | 1 | 1 | 1/0 | 5 |
| B | R02 | 1 | 1 | 1 | 1/0 | 5 |

## Complete pairs and unmatched observations

Declared pairs: 2; complete pairs: 2; unmatched observations: 0; unpaired evidence: 0.

Paired comparison: 2 pairs, control better 0, candidate better 0, ties 2; delta 0 (interval 0..0).

Full-population candidate-minus-control interval: 0..0 (worst case, not a confidence interval).

## Assessment selection

0 recovered, 0 initial, 4 unrecorded.

No slot used a recovery attempt.

| Slot | Selected attempt | Kind |
| --- | --- | --- |
| cc-A-r0-R01 | unrecorded (manifest selector) | manifest |
| cc-B-r0-R01 | unrecorded (manifest selector) | manifest |
| cc-A-r0-R02 | unrecorded (manifest selector) | manifest |
| cc-B-r0-R02 | unrecorded (manifest selector) | manifest |
## Guardrails

| Arm | Guardrail | Status | Coverage | Evidence |
| --- | --- | --- | --- | --- |
| A | mutation-policy | clean | pass 2, fail 0, unknown 0, n/a 0 | — |
| A | destructive-loss | clean | pass 1, fail 0, unknown 0, n/a 1 | — |
| B | mutation-policy | clean | pass 2, fail 0, unknown 0, n/a 0 | — |
| B | destructive-loss | clean | pass 1, fail 0, unknown 0, n/a 1 | — |

## Static screen (advisory; never changes outcomes)

The screening output republishes the one personal-trial decision: **inconclusive**.

Rules v1: 6 finding(s). Judge reconciliation: referenced 0, not-referenced 0, unresolved 6.

| Rule | Trial | Role | Source | Excerpt | Explanation |
| --- | --- | --- | --- | --- | --- |
| fact-coverage-unknown | cc-A-r0-R02 | after | a/results/cc-A-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "10-connection pool cap"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |
| fact-coverage-unknown | cc-A-r0-R02 | after | a/results/cc-A-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "5-second acquire timeout"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |
| fact-coverage-unknown | cc-A-r0-R02 | after | a/results/cc-A-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "startup migrations"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |
| fact-coverage-unknown | cc-B-r0-R02 | after | b/results/cc-B-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "10-connection pool cap"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |
| fact-coverage-unknown | cc-B-r0-R02 | after | b/results/cc-B-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "5-second acquire timeout"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |
| fact-coverage-unknown | cc-B-r0-R02 | after | b/results/cc-B-r0-R02/R02/live/lakes/docs/ops/release.md | (no excerpt) | no recognised mention of "startup migrations"; a missing keyword does not prove loss, and an unrecognised paraphrase remains possible |

A missing keyword does not prove a lost fact; a matching keyword does not prove truth. Findings are screened independently of the judge and never alter eligibility, outcomes, scores or guardrails.

## Sensitivity

| Useful | Transient | A | B | Ranking |
| --- | --- | --- | --- | --- |
| 3 | 1 | 6 | 6 | A > B |
| 3 | 2 | 6 | 6 | A > B |
| 5 | 1 | 10 | 10 | A > B |
| 5 | 2 | 10 | 10 | A > B |

The grid describes this sample; it is not a set of experiments and it does not repair missing assessments.

## Capture, integrity and costs

Judge models recorded: opencode-go/glm-5.3-flash.
Hashed input sources: 20. The full consumed-input list and the rendering identity are in analysis-receipt.json.

| Measure | Captured | Coverage | Unknown |
| --- | --- | --- | --- |
| Input tokens | 67096 | 41 observed step(s) measured | 0 observed step(s) without this field |
| Output tokens | 4778 | 41 observed step(s) measured | 0 observed step(s) without this field |
| Reasoning tokens | 1503 | 41 observed step(s) measured | 0 observed step(s) without this field |
| Cache-read tokens | 312192 | 41 observed step(s) measured | 0 observed step(s) without this field |
| Steps observed | 41 | 4 readable trail(s) | 0 unreadable trail(s) |
| Monetary cost | — | not recorded | 4 trial(s) |

Token fields keep independent coverage: a step reporting only some fields leaves the rest unknown, explicit zeros are measured, and a step without token fields still counts as an observed step.

Cost telemetry: unavailable. No monetary cost was recorded; token and step totals are reported without an invented price.

Attempt ledger: not declared.

## Limitations

- Worst-case bounds are missing-data intervals, not confidence intervals.
- Documented coverage: 4/4 planned slots.
- Static-screen findings are advisory and were generated independently of the judge; reconciliation counts only exact excerpt references.
- Screening read missing before/after lake snapshots for 4 trial(s).
- Token coverage (measured/unknown steps): input 41/0, output 41/0, reasoning 41/0, cache-read 41/0; 4 readable and 0 unreadable trial trail(s).
- This analysis made no model calls and executed no campaign-supplied code.

Authored interpretation lives in INTERPRETATION.md and is never overwritten by a rerender.
