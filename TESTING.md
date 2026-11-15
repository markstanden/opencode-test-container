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

- The measured population is `src/**/*.ts`: contracts, lifecycle, adapters,
  evaluator and CLI modules. `dist/` is generated and not measured.
- `tests/**` and `rehearsals/**` are not measured sources.
- The historical prod014 drivers remain in the docs plugin; their old coverage
  floors are not inherited or claimed here. This package's floor is recorded
  in `.defined.json` and reviewed with the same SHA.

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
