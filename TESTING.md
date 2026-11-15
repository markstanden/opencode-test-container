# Testing

Two layers, two questions:

1. **Ordinary tests** — do the contracts, lifecycle, evaluators, CLI and
   installed package behave? Node's runner; no credentials, provider calls or
   ambient Git/signing config.
2. **Offline rehearsal** — do the real Podman image, real OpenCode CLI and real
   docs plugin behave against a scripted loopback provider? Manual, separate
   from `npm test`, zero paid calls.

## Setup

Node ≥ 26 (`engines`). Reproducible install from the lockfile:

```sh
npm ci
```

## Task selector

| Task                   | Command                                 | Provider calls            |
| ---------------------- | --------------------------------------- | ------------------------- |
| One unit file          | `node --test tests/unit/<file>.test.ts` | none                      |
| Inner loop             | `npm test && npm run typecheck`         | none                      |
| Final verdict          | `defined comply`                        | none; may repair the tree |
| Installed CLI proof    | included in `npm test` (`tests/cli`)    | none                      |
| Offline real rehearsal | `npm run rehearse:offline`              | scripted loopback only    |

`npm test` builds `dist/` first because the CLI/package tests execute the
installed JavaScript shape, not only TypeScript source.

## Coverage populations

`npm run test:coverage` runs `scripts/check-coverage.mjs`, which enforces two
declared populations:

- **Migrated docs analysis** (`src/evaluators/docs/analysis/**`, excluding the
  new `replay.ts` CLI): the docs repository's inherited **95/90/95** floors.
- **All OTC runtime** (`src/**/*.ts`, including contracts, lifecycle, adapters,
  evaluators and CLI): an explicit initial ratchet of **75/55/80**.

Measured at the reconciliation head: migrated analysis 95.6/90.1/95.9; all
OTC runtime 85.1/79.4/85.5. The script fails loudly if either population
drops below its floor, and writes the `coverage/lcov.info` Sonar consumes.

The docs-analysis tests are the established analysis suite ported into
`tests/docs-analysis`, plus the committed mini replay parity test in
`tests/contract/docs-parity.test.ts`. The larger recorded confirmation and
screening corpora were replayed manually; see
[`docs/capability-matrix.md`](docs/capability-matrix.md).

## Offline rehearsal

```sh
npm run rehearse:offline
```

Requirements: Podman; an image containing OpenCode (default
`localhost/opencode-placement-trials:latest`, OpenCode 2.2.6); a docs plugin
checkout at `../opencode-docs-plugin` unless `OTC_DOCS_PLUGIN` names one.
The rehearsal starts a scripted provider, counts chat requests separately from
readiness probes and asserts:

- skill positive, negative, wrong-skill and failed-load outcomes;
- truncated capture is invalid, not a negative;
- docs useful write passes and a gate-blocked write keeps zero credit;
- no hidden criteria or campaign/suite files appear in the trial payload;
- every slot made at least one provider request and zero real calls.

Set `OTC_KEEP_REHEARSAL=1` to keep the work directory.

## Troubleshooting

| Symptom                          | First evidence                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `image not known`                | freeze resolved an ID without `sha256:`; check the adapter output                             |
| container exits 1 with no events | read `stderr.txt`; a plugin load path or provider auth failed                                 |
| `capture is invalid`             | `meta.json.captureProblems` names missing text, parse failures, timeout or overflow           |
| `delivery check failed`          | compare `prepare/manifest.json`, staged subjects and `prepare/frozen.json`                    |
| `docs journal is absent`         | confirm `docs-task` case, `DOCS_OPERATION_JOURNAL*` env file entries and the `/journal` mount |
| `trial budget exhausted`         | the ledger has as many `trial-start` events as the declared budget                            |
| `campaign is closed`             | closure is final; start a fresh root                                                          |
