# Architecture and extraction ownership

Status: implemented 2026-11-15. Source repository:
`markstanden/opencode-docs-plugin` @ `76ed331` (`main`, clean at review).
Destination: this repository.

## Decision

Two repositories, one OTC package. The docs plugin owns the product and its
real evaluation corpus; OTC owns the reusable lifecycle, sandbox adapters,
evidence boundary and evaluator implementations. OTC does not depend on the
docs plugin at runtime, and the docs plugin does not depend on OTC at runtime.
The docs repository's development tooling pins an immutable OTC artifact.

The extraction is not a directory move. The new lifecycle validates versioned
suite/campaign data, stages immutable subject payloads, freezes the resolved
image and CLI identity, appends an explicit ledger, separates capture validity
from criterion outcome, and derives read-only status. Docs-specific semantics
live only under `src/evaluators/docs`.

## Why these seams

- **Subject vs runtime vs suite vs campaign.** A skill-only subject must run
  without a plugin or lake; a paired docs comparison must not force a skill
  case into a docs schema. One discriminated contract serves both.
- **Capture vs outcome.** A complete stream ending normally is valid evidence;
  an activation expectation can then fail. A truncated stream, missing key or
  failed target load is an operational unknown, never a passing negative.
- **Trusted evaluators.** The CLI wires evaluator implementations. Campaign
  data names an assessment kind; it never names executable JavaScript loaded
  from evidence. A parsed JSON object is never trusted as results: status,
  closure, reporting and judge selection read through `src/evidence`, which
  checks shape, slot identity, evaluator version, source-evidence hashes and
  the authoritative ledger binding.
- **Contained snapshots.** Workspace and lake content is read only through one
  containment policy (`src/evidence/containment.ts`): real roots, no symlinked
  directory traversal, resolved containment, `O_NOFOLLOW` opens and controlled
  refusal of special files. An unsafe object blocks packet and assessment
  construction rather than becoming “no changes”.
- **Durable trial ownership.** Trial spend uses the same exclusive-claim
  abstraction as judge and recovery. A claim is the arbitration point before
  staging or dispatch, and closure refuses unresolved claims. Trial budget is
  therefore atomic across processes, and an ambiguous attempt is never
  refunded.
- **One stop policy.** `src/campaign/stop-policy.ts` owns a versioned truth
  table for run, assess and judge; legacy roots keep version-1 semantics.
- **Historical identity.** Old stamps, scenario ids and frozen `.mjs` bytes are
  records. `legacy/prod014.ts` translates them without renaming. Old roots are
  not resumed by this engine.

## Source-to-destination manifest

| Source (`opencode-docs-plugin` @ 76ed331)                                                               | Destination                                                                   | Class                                    |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `tests/fixtures/placement-harness/harness.mts` (case schemas, generation, run, capture)                 | `src/contracts`, `src/campaign`, `src/adapters`                               | split + rewrite                          |
| `.../analysis/{budget,closure,freeze,ledger,recovery,selector}.ts`                                      | `src/campaign/{ledger,freeze,close,run,assess}.ts`                            | split + rewrite                          |
| `.../analysis/journal.ts`                                                                               | `src/evaluators/docs/journal.ts`                                              | move (bytes preserved apart from header) |
| `.../analysis/{accounting,records,guardrails,measures,render,model,decision,pairing,bounds,closure}.ts` | `src/evaluators/docs/analysis/*`                                              | move                                     |
| `.../analysis/screening/*`                                                                              | `src/evaluators/docs/analysis/screening/*`                                    | move                                     |
| `.../ac/*`, `prod014/campaign/active/*`, `status.mts`                                                   | `src/legacy/prod014.ts` readers; old engine stays pinned in docs              | legacy                                   |
| `.../Containerfile`, `container-run.sh`                                                                 | `container/Containerfile`, `src/adapters/podman`                              | rewrite                                  |
| `.../primary-checks/*`, placement corpus, truth, measurement                                            | docs `evaluations/docs-placement/`; OTC stages and executes supplied checkers | data stays; execution moves              |
| `.../ac-scoring.mts` judge prompt, classification, recovery policy                                      | `src/evaluators/docs/scoring.ts`, `src/campaign/judge.ts`                     | move + rewrite                           |
| docs `src/index.ts` (metadata, ranking, collection, convention)                                         | docs `src/{metadata,ranking,collection,convention}.ts`                        | split                                    |
| docs `src/index.ts` (lakes, publication, tools, plugin)                                                 | docs `src/lakes.ts`, `src/publication.ts`, `src/index.ts`                     | split                                    |

## Dependency direction

```
cli -> campaign lifecycle -> contracts
       |                    |
       +-> adapters (opencode, podman, process)
       +-> evaluators (docs, skills) -> evidence/contracts
       +-> reporting
legacy -> contracts only
```

`src/contracts` imports only Node built-ins. `src/evaluators/docs/journal.ts`
imports only `node:crypto` and `node:util`. No core module imports a docs
checkout or reads an ambient Git repository at import time.

The migrated `harness/run.ts` CLI has been removed: it could spawn the docs
repository's `tests/fixtures/placement-harness/harness.mts`, which is an active
cross-repository engine dependency. The reusable evidence guard now lives at
`src/campaign/evidence-guard.ts`, and the one judge-operation renderer is local
to `src/evaluators/docs/assess.ts`. Product-supplied suites and checker bytes
remain external data; OTC stages, hashes and executes them.

## Sandbox boundary

- Subject payloads are staged into `prepare/subjects/<armId>`, inventories
  hashed, and mounted read-only at `/subjects`.
- Case workspaces are staged once and copied per trial; only that copy is
  writable at `/workspace`.
- The config home (skills catalogue and `opencode.json`) is read-only at
  `/config-home`.
- The docs journal is the only other writable mount, and only for docs cases.
- A product checker is staged at `prepare/primary-checks/<caseId>` and run in
  a separate `network: "none"` container with the completed workspace and the
  pristine workspace read-only. It is never mounted into the trial.
- The judge runs in a neutral container with the packet read-only, a neutral
  config home and no arm subjects, campaign manifest or evidence root. Its
  standing-permission block comes from the pristine prepared workspace, never
  the trial's live `AGENTS.md`.
- Suite, campaign, manifest, truth, criteria and other slots are outside the
  model-visible filesystem.
- Credentials travel through a 0600 env file; argv and receipts carry names and
  hashes only. Trial, judge and recovery reservations live under
  `<root>/evidence/{trial,judge,recovery}` and are never released if dispatch
  might have happened.
- `network: "host"` is honest host networking, not provider-only egress.

## Evidence, lifecycle and execution seams

```
campaign/{run,assess,judge,close,status,report}
        |
        +-> evidence/{containment,capture,source-identity,assessments}
        +-> campaign/{reservations (budget),publication,stop-policy}
        +-> adapters/{process,podman,opencode}
```

- `src/evidence` distinguishes missing, valid, corrupt, unsupported and
  conflicting records. Capture validity is derived from the raw stream and
  reconciled with saved metadata, not read from a flag.
- Assessment identity excludes `assessedAt`: repeating identical work reuses
  the first record and timestamp, changed evidence is refused, and unrun state
  is derived rather than persisted.
- Process capture bounds each stream in bytes, marks overflow explicitly and
  decodes complete UTF-8. Trial and judge environment files are removed on
  every path; owned containers are stopped and removed by their own name.
- `npm test` stays hermetic; `npm run test:smoke` is the real-container proof
  (`docs/smoke.md`). It needs no sibling docs checkout.

## Removal condition for the docs bridge

The old prod014 engine remains in the docs repository, pinned to its original
runtime and code, until an OTC campaign reaches parity on the same frozen
evidence. It is not a second active engine: new campaigns use OTC only. The
docs `evaluations/README.md` names the owner and the removal condition.

Primary-check execution now has an OTC home; the docs repository still owns
the checker bytes and corpus. The removal condition therefore waits on the
docs agent repinning the new OTC artifact and, if it chooses, deleting the old
prod014 route after its own parity check. OTC does not rewrite old roots.
