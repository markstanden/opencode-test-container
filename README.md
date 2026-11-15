# OpenCode Test Container

An isolated test sandbox for OpenCode plugins, skills and agent instructions.

`otc` prepares an immutable campaign, freezes every input identity, runs each
scheduled slot in a Podman sandbox through the real OpenCode CLI, executes the
product's primary check, assesses the captured evidence deterministically,
optionally dispatches an arm-blind judge, closes the ledger and renders a
report. The judge is the only model call OTC makes; a campaign either uses a
scripted loopback provider (offline) or the host provider route the runtime
declares (potentially paid).

```sh
npm install --global @markstanden/opencode-test-container
otc help
```

The installed binary is emitted JavaScript and carries every runtime asset; it
does not need a checkout, `tsx` or Bun.

## The model

| Term       | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| suite      | reusable, discriminated case definitions and assessment kind |
| case       | one prompt/context and its expected behaviour                |
| campaign   | one frozen scheduled execution                               |
| arm        | one treatment configuration (subjects + non-secret options)  |
| slot       | one case × arm × repetition                                  |
| trial      | one execution of a slot                                      |
| assessment | deterministic or model-based evaluation                      |
| report     | derived output, outside immutable evidence                   |

A minimal skill-only campaign needs no docs plugin, no knowledge lake and no
judge. See [`examples/skills`](examples/skills).

## Quick start (offline, no provider call)

```sh
otc validate --campaign examples/skills/campaign.json
otc prepare  --campaign examples/skills/campaign.json --root /tmp/otc-run
otc freeze   --root /tmp/otc-run
otc run      --root /tmp/otc-run --dry-run   # inspect the plan, no dispatch
otc run      --root /tmp/otc-run             # real Podman + OpenCode
otc judge    --root /tmp/otc-run             # optional blind judge, if declared
otc assess   --root /tmp/otc-run             # deterministic, zero judge calls
otc close    --root /tmp/otc-run
otc analyse  --root /tmp/otc-run --out /tmp/otc-report
otc status   --root /tmp/otc-run --json
```

`status` is read-only: it does not build images, probe providers, repair files
or dispatch. Its next actions are derived from the manifest and checked
evidence, not from baked-in campaign constants.

## Suite format

Versioned JSON (`schemaVersion: 1`). `assessment` selects one trusted
evaluator; cases are discriminated.

```jsonc
{
    "schemaVersion": 1,
    "suiteId": "skills-basic",
    "assessment": "skill-activation",
    "cases": [
        {
            "caseId": "positive-instrument",
            "kind": "skill-trigger",
            "targetSkillId": "otel-helper",
            "expected": "activation",
            "prompt": "Instrument the checkout service with OpenTelemetry spans.",
        },
        {
            "caseId": "negative-near-miss",
            "kind": "skill-trigger",
            "targetSkillId": "otel-helper",
            "expected": "no-activation",
            "prompt": "Add a console log; no telemetry is needed.",
        },
    ],
}
```

Docs cases use `kind: "docs-task"`, `expectedDocs`, an optional `criterion`
and deterministic `guardrails`. An optional `primaryCheck` names a
product-supplied checker directory and script; it is staged read-only and run
in its own no-network container after the trial, never mounted into the trial.
`truth` is arm-blind judge context and never enters a workspace. Docs evidence
is assessed from the plugin's signed operation journal, never from a transcript
claim.

## Campaign format

```jsonc
{
    "schemaVersion": 1,
    "campaignId": "skills-local",
    "suite": { "path": "suite.json", "sha256": "<optional pinned hash>" },
    "subjects": [
        {
            "armId": "skill-only",
            "skills": [{ "id": "otel-helper", "path": "skills/otel-helper" }],
            "plugins": [{ "id": "docs", "path": "/abs/path/to/plugin" }],
            "instructions": [
                { "id": "overlay", "path": "AGENTS.md", "as": "AGENTS.md" },
            ],
        },
    ],
    "schedule": {
        "kind": "explicit",
        "slots": [
            {
                "slotId": "s1",
                "caseId": "positive-instrument",
                "armId": "skill-only",
                "repetitionId": "r0",
            },
        ],
    },
    "runtime": {
        "image": "localhost/otc-sandbox:2.2.6",
        "imageId": "sha256:…",
        "opencodeVersion": "2.2.6",
        "provider": {
            "route": "scripted",
            "model": "vendor/model",
            "overlay": {},
        },
        "timeoutMs": 180000,
        "network": "host",
        "passthroughEnv": ["PROVIDER_API_KEY"],
    },
    "budgets": { "trials": 1, "judgeAttempts": 2 },
    "assessment": { "kind": "skill-activation" },
}
```

A docs campaign may declare a judge and a narrow recovery registration:

```jsonc
"budgets": { "trials": 4, "judgeAttempts": 8 },
"assessment": {
    "kind": "docs-recording",
    "judge": { "model": "provider/model", "timeoutMs": 180000 },
    "recovery": {
        "version": 1,
        "eligibleFailureClasses": ["json-syntax"],
        "requiresCompletionEvidence": true,
        "maxRecoveriesPerSlot": 1,
        "recoveryCeiling": 4,
        "totalJudgeAttempts": 8,
        "providerRequestLimit": null
    }
}
```

`judgeAttempts` counts dispatches, not HTTP requests. Each attempt is claimed
durably before it starts; a reserved or spawned claim keeps consuming budget.
"none" in `network` is the only true no-egress mode; without `judgeAttempts`
a campaign makes no model call of its own.

Subject sources may be local paths; they are copied into
`prepare/subjects/<armId>` before dispatch. Relative paths resolve against the
campaign document. Symlinks escaping a source root, path collisions and
unreadable inventories are refused. Only the staged payload is mounted — never
the whole OTC repository, the complete subject repository, other cases, truth
or rubric data.

## Assessment

- `skill-activation` is deterministic and makes zero judge calls. It records
  the requested target, successful target loads, failed target loads, other
  skill loads and no-invocation separately. Capture validity is separate from
  the criterion: a complete run with no activation is an observed negative; a
  missing/truncated capture or a failed target load is unknown/invalid, never a
  passing negative. A non-skill route to the target body is contamination.
- `docs-recording` verifies the plugin's HMAC-signed journal against the host
  tool trail, then checks the written bytes. A refused write retains zero
  recording credit; attempts are counted separately.
- The full recorded-evidence analyser is also available offline:

    ```sh
    otc replay --manifest <campaign.json> \
      --evidence-root <recorded-evidence-root> --out <fresh-report-dir>
    ```

    It validates the declared campaign, loads explicit evidence states, and
    produces accounting, utility/opportunity counts, retrieval measures,
    preservation, guardrails, pairing, bounds, screening, decision and stable
    reports. It makes no model call. `--allow-legacy-unbound` is the explicit
    legacy-answer escape; `--rerender` replaces an existing output.

- An optional docs judge is arm-blind by construction: the packet contains the
  task, standing permission, authored truth, before/after lake documents,
  changed paths, primary-check output, verified docs operations and the final
  answer. It contains no arm label, campaign identity, evidence root or prior
  verdict. The established parser and validator classify a usable judgement or
  an explicit `json-syntax`, `schema`, `semantic`, `empty-or-truncated` or
  `transport-or-process` failure. Only `json-syntax` is recoverable, and only
  once, from identical packet bytes under a registered policy and durable
  ceilings.

Model judging is not a deterministic pass/fail substitute: the deterministic
assessment remains the criterion, and the judge records the documentation
outcome and utility. A campaign that declares a judge is not refused.

A selection is accepted only through one checked reader shared by judge,
status, closure and reporting: attempt set, packet bytes, policy hash,
judgement hash, outcome/utility and the judged mutation state are re-derived.
Slot and attempt packet bytes are hashed and compared with the registered
identity and with the packet reconstructed from current evidence.
Judge and recovery claims live under `campaign root/evidence`; a recovery
settles both, and an interrupted claim stays visible and blocks closure. The
judge's standing-permission block comes from the pristine prepared workspace,
never the trial's live `AGENTS.md`. Before dispatch, the executing artifact
hash is compared with the freeze, derived from the executing module's own
`src`/`dist` tree, so changed code under the same package version is refused.

## Sandbox limits

The container is read-only apart from the trial workspace, `/tmp` and (for
docs cases) the journal directory. Capabilities are dropped and
`no-new-privileges` is set. With `network: "host"` the trial shares the host
network so a loopback provider proxy is reachable; that is **not** network
isolation and OTC does not describe it as provider-only egress. Credentials
travel through a 0600 env file, never argv, logs or receipts.

A product primary checker runs in a separate `network: "none"` container with
only the completed workspace, the pristine workspace and the staged checker
mounted read-only. The judge runs in another neutral container with no arm
subjects, no campaign manifest and no evidence root.

## Docs evaluator capability

`src/evaluators/docs` carries the established docs analysis semantics, not a
narrower recording-only criterion: recording credit, utility and opportunity
counts, retrieval, preservation, guardrails, pairing/bounds, screening,
decision and reporting. `docs/capability-matrix.md` maps every capability to
its original implementation, tests, parity evidence and remaining owner.

## Historical compatibility

`src/legacy/prod014.ts` translates the frozen prod014 schedule and manifest
into the new vocabulary without renaming a stamp or scenario id. The old
campaign roots are not resumed by this engine; use a fresh root and keep the
original for provenance.

## Development

See [AGENTS.md](AGENTS.md) and [TESTING.md](TESTING.md). The offline real
rehearsal is separate from `npm test`:

```sh
npm run rehearse:offline
npm run rehearse:fresh-docs
npm run rehearse:installed
```

The second rehearsal exercises the complete fresh docs lifecycle: primary
check, blind judge, one recovery, an exhausted budget, checked selection,
closure, analysis and post-close refusal. The third packs and installs the
tarball and repeats the same lifecycle through the installed binary; see
[TESTING.md](TESTING.md).
