# PR — extract OTC: an isolated test sandbox for OpenCode plugins, skills and instructions

## Summary

Adds `@markstanden/opencode-test-container` (`otc`) as a new package:

- versioned suite/campaign/subject/runtime contracts with discriminated
  `skill-trigger` and `docs-task` cases;
- immutable preparation, freeze and delivery checks (resolved image ID, CLI
  version, subject and prompt hashes);
- explicit scheduled execution through Podman and the real OpenCode CLI;
- append-only lifecycle ledger, deterministic assessment, idempotent closure,
  read-only status and derived reports;
- the established docs analysis implementation (recording credit, utility and
  opportunity counts, retrieval, preservation, guardrails, pairing/bounds,
  screening, decision and reporting) with its ported contract suite;
- deterministic skill-activation evaluator;
- emitted-JavaScript `otc` bin proven through `npm pack` in a temporary
  consumer;
- offline real-adapter rehearsal with a scripted loopback provider;
- explicit legacy readers for frozen prod014 schedule/manifest records.

## Design

`docs/architecture.md` records the source-to-destination ownership manifest and
the subject/runtime/suite/campaign/assessment split. `docs/schema.md` records
the glossary and migration table. Core imports only contracts and adapters; it
never imports a docs checkout or assumes A/B, eight pairs, a judge or a
provider. Docs semantics live only in `src/evaluators/docs`.

## Proof

- `npm ci`, `npm test` (60 tests, including packaged CLI), `npm run typecheck`,
  `defined comply --full` all pass.
- Measured coverage on the new `src/**/*.ts` population: 81.0 line, 58.5
  branch, 84.3 function. The explicit initial floor is 75/55/80; this
  population was never previously gated (the old prod014 drivers remain in the
  docs repository).
- Recorded-evidence parity: committed mini corpus deep-equal; recorded 40-trial
  confirmation and 48-trial screening corpora byte-identical apart from the
  receipt's `renderedAt`.
- Coverage ownership: migrated analysis keeps the inherited 95/90/95 floors
  (measured 95.6/90.1/95.9); all OTC runtime has an explicit 75/55/80 initial
  ratchet (measured 85.1/79.4/85.5).
- `npm run rehearse:offline`: real Podman image
  `sha256:58505eac…`, OpenCode 2.2.6, scripted provider. 22 chat requests, 0
  readiness probes, 0 paid calls. Skill positive/negative/wrong/failed-load
  and invalid capture; docs useful write and gate-blocked write.
- Installed tarball runs help, validate, prepare and status from an unrelated
  directory, with no checkout or `tsx`/Bun dependency.

## Limits

- Model judging is not implemented; a campaign declaring a judge is refused.
- `network: "host"` is documented honestly as host networking, not
  provider-only egress.
- Publishing to npm and creating the remote are external steps; the repository
  is ready to publish.
