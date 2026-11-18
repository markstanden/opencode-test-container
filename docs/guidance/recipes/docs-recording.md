# Docs recording with a primary check

A `docs-task` suite asks whether the docs plugin records the right thing, and
whether it records nothing when it should. The deterministic assessment reads
the plugin's signed operation journal, never the transcript.

This recipe needs a docs plugin bundle at `plugins[].path`. The repository
rehearsal uses [`rehearsals/fixtures/docs`](../../../rehearsals/fixtures/docs)
with the plugin checkout supplied as `DOCS_PLUGIN_PATH`; that directory is not
in the published package, so treat this as a configuration recipe rather than a
one-command run.

## Arm and campaign

```json
{
    "subjects": [
        {
            "armId": "docs-plugin",
            "plugins": [
                { "id": "docs", "path": "/path/to/opencode-docs-plugin" }
            ]
        }
    ],
    "schedule": {
        "kind": "explicit",
        "slots": [
            {
                "slotId": "useful-write",
                "caseId": "useful-write",
                "armId": "docs-plugin",
                "repetitionId": "r0"
            },
            {
                "slotId": "gate-blocked",
                "caseId": "gate-blocked",
                "armId": "docs-plugin",
                "repetitionId": "r0"
            }
        ]
    },
    "budgets": { "trials": 2, "judgeAttempts": 0 },
    "assessment": { "kind": "docs-recording" }
}
```

The plugin package is mounted at `/subjects/plugins/docs` and registered in the
generated `opencode.json`. A docs case additionally gets a writable journal
mount; the signing key lives beside the trial evidence, never in the workspace.

## Cases

```json
{
    "caseId": "useful-write",
    "kind": "docs-task",
    "prompt": "Record the OpenTelemetry span convention in the repo lake.",
    "lakeRoot": "docs",
    "fixture": "workspace",
    "expectedDocs": {
        "kind": "create",
        "target": "notes/otel.md",
        "retains": ["OpenTelemetry"]
    },
    "criterion": { "minVerifiedCalls": 1, "verbs": ["add"] },
    "guardrails": { "unchanged": ["README.md"] }
}
```

- `expectedDocs.kind: "none"` is the restraint case: the write must be refused,
  and a refused write retains zero recording credit.
- `criterion.minVerifiedCalls: 0` is a legitimate restraint expectation; it is
  not "any call will do".
- `guardrails` checks the final workspace (`unchanged`, `absent`).
- `fixture` resolves against the suite document and supplies the workspace lake
  at `lakeRoot` (default `docs`).

## Primary check

A product-supplied checker runs **after** the trial in its own no-network
container, with the completed workspace at `/live` and the pristine prepared
workspace at `/pristine`, both read-only. It is never mounted into the trial.

```json
{
    "caseId": "useful-write",
    "kind": "docs-task",
    "primaryCheck": {
        "id": "otel-installer",
        "directory": "checkers",
        "script": "check.mjs",
        "timeoutMs": 30000
    }
}
```

`directory` resolves against the suite document; the interpreter is fixed to
`node`, so the contract is `node /checker/<script> /live /pristine`. A failing
checker makes the criterion fail; a timeout or spawn error is `unknown`; a
declared checker with no result is `invalid`. Put the checker in the suite
directory tree, not in the trial workspace.

## Run

```sh
otc validate --campaign campaign.json
otc prepare  --campaign campaign.json --root /tmp/otc-docs
otc freeze   --root /tmp/otc-docs
otc run      --root /tmp/otc-docs
otc assess   --root /tmp/otc-docs
otc close    --root /tmp/otc-docs
otc analyse  --root /tmp/otc-docs --out /tmp/otc-docs-report
```

The trial can use the scripted provider from
[`scripted-skill-activation.md`](scripted-skill-activation.md) when the plan
exercises docs calls; a real route is needed when the model must choose the
calls itself.

## Expected evidence

- `evidence/trials/<slot>/journal/docs-operations.jsonl` — the signed operation
  journal the assessment verifies.
- `evidence/trials/<slot>/journal-key.txt` — the 0600 key; never printed.
- A primary-check record per case that declared a checker.
- One deterministic assessment per slot binding the capture, metadata, journal
  and key hashes.

A useful write should pass; a restraint case passes only when the write was
refused. A write that was refused but reported as recorded is a failure, not a
partial credit.

## What it does not prove

- That the documentation is useful. That is the optional semantic judge —
  [`docs-judge.md`](docs-judge.md) — and it does not replace the deterministic
  criterion.
- That the checker is correct. It is product data; OTC stages and runs it
  faithfully, including a wrong expectation.
- That the journal records an intent the model had; it records operations the
  plugin performed.

Next: the optional judge —
[`docs-judge.md`](docs-judge.md).
