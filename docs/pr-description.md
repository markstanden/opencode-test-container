# PR — extract OTC: an isolated test sandbox for OpenCode plugins, skills and instructions

## Summary

Adds `@markstanden/opencode-test-container` (`otc`) as a new package:

- versioned suite/campaign/subject/runtime contracts with discriminated
  `skill-trigger` and `docs-task` cases;
- immutable preparation, freeze and delivery checks (resolved image ID, CLI
  version, subject, prompt and product-checker hashes);
- explicit scheduled execution through Podman and the real OpenCode CLI;
- product-supplied primary checks executed in their own no-network container,
  never mounted into the trial;
- an arm-blind docs judge using the established prompt/parse/validate/failure
  classification, with one registered `json-syntax` recovery from identical
  packet bytes and durable per-slot selection;
- append-only lifecycle ledger, deterministic assessment, idempotent closure,
  read-only status and derived reports;
- the established docs analysis implementation (recording credit, utility and
  opportunity counts, retrieval, preservation, guardrails, pairing/bounds,
  screening, decision and reporting) with its ported contract suite;
- deterministic skill-activation evaluator;
- emitted-JavaScript `otc` bin proven through `npm pack` in a temporary
  consumer;
- offline real-adapter rehearsals for both the skill/docs baseline and the
  complete fresh docs lifecycle;
- explicit legacy readers for frozen prod014 schedule/manifest records.

## Design

`docs/architecture.md` records the source-to-destination ownership manifest and
the subject/runtime/suite/campaign/assessment split. `docs/schema.md` records
the glossary and migration table. Core imports only contracts and adapters; it
never imports a docs checkout or assumes A/B, eight pairs, a judge or a
provider. Docs semantics live only in `src/evaluators/docs`.

A checker is trusted product data. OTC accepts, stages and executes it; the
docs repository still owns the case data, truth and checker bytes. The trial
cannot read the checker, and the judge cannot read the campaign or arm
identities.

## Evidence-guarantee repair pass

Four independently reproduced blockers are closed:

- one checked-selection reader is shared by judge, status, closure and report;
  it re-derives attempt identity, packet identity, policy hash, judgement
  SHA-256, outcome/utility and the judged mutation state. A readable `{}` is
  not a judgement and cannot permit closure;
- judge and recovery claims now share `<root>/evidence`; a recovery settles both
  claims by dispatch outcome, and an interrupted dispatch leaves visible
  `spawned` claims that block closure;
- the judge's standing permission is read from the pristine prepared workspace,
  never the trial's live `AGENTS.md`; A/B instruction canaries are absent from
  both packets;
- the checked reader hashes the actual slot and attempt packet bytes, compares
  them with registered identities and with the packet reconstructed from
  current evidence, and reports missing/changed packets across judge, status,
  closure and report;
- the executing tool identity includes an artifact hash derived from the
  executing module's own `src`/`dist` location and is compared with the freeze
  before `run`, `judge`, `delivery-check` or `status` trusts it; source
  execution beside a build and installed JavaScript execution each fingerprint
  the right tree. Read-only historical replay remains independent of the
  freeze.

## Proof

- `npm ci`, `npm test` (552 tests, including packaged CLI), `npm run
typecheck`, `defined comply` all pass.
- Coverage populations, all measured on this head:
    - migrated docs analysis keeps the inherited 95/90/95 floors
      (95.6/90.2/95.9);
    - all OTC runtime has the explicit 75/55/80 ratchet (91.6/80.2/93.0);
    - the genuinely new lifecycle/adapters/evaluators population has an explicit
      82/66/84 ratchet (87.8/71.3/90.0).
- Recorded-evidence parity: committed mini corpus deep-equal; recorded 40-trial
  confirmation and 48-trial screening corpora byte-identical apart from the
  receipt's `renderedAt`.
- `npm run rehearse:offline`: real Podman image, OpenCode 2.2.6, scripted
  provider, zero paid calls.
- `npm run rehearse:fresh-docs`: primary pass/fail, useful and gate-blocked
  writes, malformed-then-valid judge recovery selecting `attempt-002` with
  identical packet bytes, exhausted budget refusal, checked selection,
  closure, analysis and post-close refusal. 6 trial + 5 judge + 1 exhausted
  scripted chat requests, 0 readiness probes, 0 paid calls.
- Installed tarball runs the complete offline docs lifecycle from an unrelated
  directory with spaces, with no checkout or `tsx`/Bun dependency. The receipt
  records the tarball filename, SHA-256 and npm integrity.
- The migrated `harness/run.ts` CLI is removed, so no OTC source can spawn the
  docs repository's `placement-harness/harness.mts`. Only product-supplied
  suite and checker bytes remain external data.

## Limits

- The judge is a model call when dispatched; it is not deterministic evidence.
  The deterministic assessment remains the criterion.
- `network: "host"` is documented honestly as host networking, not
  provider-only egress.
- The two larger recorded parity corpora remain external and are not
  committed; the committed mini corpus enforces the same pipeline.
- Publishing to npm and creating the remote are external steps; the repository
  is ready to publish.
