[![Quality gate](https://sonarcloud.io/api/project_badges/quality_gate?project=markstanden_opencode-test-container)](https://sonarcloud.io/summary/new_code?id=markstanden_opencode-test-container)

# OpenCode Test Container

An isolated test sandbox for OpenCode plugins, skills and agent instructions.

`otc` prepares an immutable campaign, freezes every input identity, runs each
scheduled slot in a Podman sandbox through the real OpenCode CLI, executes the
product's primary check, assesses the captured evidence deterministically,
optionally dispatches an arm-blind judge, closes the ledger and renders a
report. A trial is a real agent run: OpenCode may make several provider
requests, so the trial budget bounds agent work, not necessarily billing. The
deterministic assessment and evidence replay make no model call; the optional
judge is one additional, separately budgeted model call. A campaign either uses
a scripted loopback provider (no credentials, no paid requests) or the host
provider route the runtime declares (potentially paid).

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

## Quick start

Requirements: Node 26 (`engines`) and rootless Podman 5+ for any lane that
dispatches. The no-dispatch lane needs neither a container runtime nor a
network.

```sh
npm install --global @markstanden/opencode-test-container
otc --version
```

From a checkout, `dist/` must be built first (`npm ci && npm run build`); set
`OTC_CLI` to that path if you invoke the rehearsals.

### Validate and plan — no provider dispatch

```sh
otc validate --campaign examples/skills/campaign.json
otc prepare  --campaign examples/skills/campaign.json --root /tmp/otc-run
otc freeze   --root /tmp/otc-run
otc run      --root /tmp/otc-run --dry-run   # verify the plan, no dispatch
otc status   --root /tmp/otc-run --json
```

`run --dry-run` builds and validates each selected slot's plan and prints one
`admissible` or `refused` line per slot with a reason: `budget:` when the
durable budget or an earlier slot in the same preview leaves nothing, and
`staging:` when the prepared payload cannot produce a plan. It creates no
claim, so the snapshot is read-only. Validation success only proves the
configuration is well formed, not that the experiment measures what you intend
— see [`docs/guidance/choose-what-youre-measuring.md`](docs/guidance/choose-what-youre-measuring.md).
The guidance entry point is [`docs/guidance/README.md`](docs/guidance/README.md).

### Scripted execution — real containers, local provider

```sh
otc run      --root /tmp/otc-run   # real Podman + OpenCode
otc assess   --root /tmp/otc-run   # deterministic; required before judging
otc judge    --root /tmp/otc-run   # optional blind judge, if declared
otc close    --root /tmp/otc-run
otc analyse  --root /tmp/otc-run --out /tmp/otc-report
```

These trials dispatch the real OpenCode CLI, but the provider is a scripted
loopback server, so no credential is read and no paid request is made. The
example expects that server at `127.0.0.1:8799`; start it before `run` — see
[`examples/skills`](examples/skills).

`assess` comes before `judge`. A judge dispatch requires a checked
deterministic assessment whose capture is valid and whose outcome is pass or
fail; a missing, invalid or untrusted assessment refuses the whole judge
invocation before any claim, so it costs zero paid attempts. A valid adverse
result is eligible. `judge` refuses nothing else silently: `status` names the
slots still pending and why.

Each trial's evidence is under `/tmp/otc-run/evidence/trials/<slotId>/`; the
deterministic assessment is `evidence/assessments/<slotId>.json`; a judged
slot's packet, attempts and `selection.json` are under
`evidence/judgements/<slotId>/`. The rendered report is the `--out` directory
(`report.json` and `report.md`).

### Real-provider execution — potentially paid

Point `runtime.provider.overlay` at your route and name the credential in
`passthroughEnv`. Each trial can then make several provider requests: budget
`budgets.trials` and `timeoutMs` from measured cost, not from
`judgeAttempts`. The judge is one additional, separately budgeted model call
per selected slot, dispatched only after the deterministic assessment is
checked.

Neither `network: "host"` nor a judge turn is isolated egress: host networking
is honest host networking, and a paid route is a real provider call.

`status` is read-only: it does not build images, probe providers, repair files
or dispatch. Its next actions are derived from the manifest and checked
evidence, not from baked-in campaign constants, and it distinguishes an unrun
slot, a pending judgement, a terminal judge failure and an assessment that must
run first.

### From an empty consumer directory

The candidate tarball is the package this release produces; the same commands
work for the published package with its version substituted.

```sh
mkdir otc-quickstart && cd otc-quickstart
npm init -y >/dev/null
npm install /path/to/markstanden-opencode-test-container-0.2.0.tgz
PKG="$(npm root)/@markstanden/opencode-test-container"
OTC="$PWD/node_modules/.bin/otc"   # a local install, not a global one
ROOT="$(mktemp -d)/run"

# Locate the shipped assets.
ls "$PKG/examples/skills" "$PKG/examples/provider" "$PKG/container"

# Build the pinned sandbox image once, then reuse its ID.
podman build \
  --build-arg NODE_BASE=docker.io/library/node:26.13.0-slim \
  --build-arg OPENCODE_VERSION=2.2.6 \
  --build-arg HOST_UID="$(id -u)" \
  --build-arg HOST_GID="$(id -g)" \
  -t localhost/otc-sandbox:2.2.6 "$PKG/container"

# Start the shipped scripted provider on the example's port.
node "$PKG/examples/provider/server.mjs" --port 8799 \
  --plan "$PKG/examples/skills/provider-plan.json" &
curl --fail http://127.0.0.1:8799/health

export ZAI_API_KEY=not-a-real-key
"$OTC" validate --campaign "$PKG/examples/skills/campaign.json"
"$OTC" prepare  --campaign "$PKG/examples/skills/campaign.json" --root "$ROOT"
"$OTC" freeze   --root "$ROOT"
"$OTC" run      --root "$ROOT" --dry-run
"$OTC" run      --root "$ROOT"
"$OTC" assess   --root "$ROOT"
"$OTC" status   --root "$ROOT" --json
"$OTC" close    --root "$ROOT"
"$OTC" analyse  --root "$ROOT" --out "$ROOT/report"

ls "$ROOT/evidence/trials"          # one directory per dispatched slot
ls "$ROOT/evidence/assessments"     # deterministic records
ls "$ROOT/report"                   # report.json and report.md
```

The packaged `examples/skills/campaign.json` names
`localhost/otc-sandbox:2.2.6`; `container/README.md` carries the full build
arguments. The rehearsal [`rehearsals/installed.mts`](rehearsals/installed.mts)
runs this route from an installed tarball in a path containing a space.

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
    "suite": { "path": "suite.json" },
    "subjects": [
        {
            "armId": "skill-only",
            "skills": [{ "id": "otel-helper", "path": "skills/otel-helper" }],
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
        "opencodeVersion": "2.2.6",
        "provider": {
            "route": "scripted",
            "model": "zai-coding-plan/glm-5.3-flash",
            "overlay": {
                "providers": {
                    "zai-coding-plan": {
                        "settings": { "baseURL": "http://127.0.0.1:8799/v1" },
                    },
                },
            },
        },
        "timeoutMs": 120000,
        "network": "host",
        "passthroughEnv": ["ZAI_API_KEY"],
    },
    "budgets": { "trials": 1, "judgeAttempts": 0 },
    "assessment": { "kind": "skill-activation" },
}
```

The shipped [`examples/skills/campaign.json`](examples/skills/campaign.json)
uses this shape with three cases. The model names a real catalogue provider
whose base URL the overlay rewrites to the loopback fixture; `ZAI_API_KEY` is
a placeholder value that never reaches the real service. Optional fields —
plugin subjects, instruction overlays, `imageId` pinning, docs `primaryCheck`,
judge and recovery declarations — are specified in
[`docs/schema.md`](docs/schema.md). Keep this sample runnable and add optional
fields only when the experiment needs them.

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

`judgeAttempts` counts judge dispatches, not HTTP requests, and does not bound
the provider requests the OpenCode run inside each trial may make. Each attempt
is claimed durably before it starts; a reserved or spawned claim keeps
consuming budget. "none" in `network` is the only true no-egress mode; without
`judgeAttempts` OTC schedules no judge call of its own, and trials still
dispatch OpenCode.

Subject sources may be local paths; they are copied into
`prepare/subjects/<armId>` before dispatch. Relative paths resolve against the
campaign document (the full base table is in
[`docs/schema.md`](docs/schema.md#path-bases)). Symlinks escaping a source
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
  verdict. The packet is streamed to the judge on stdin, so no packet byte is
  in the process argument vector and a packet larger than the host's
  single-argument limit still arrives intact. The established parser and
  validator classify a usable judgement or an explicit `json-syntax`, `schema`,
  `semantic`, `empty-or-truncated` or `transport-or-process` failure. Only
  `json-syntax` is recoverable, and only once, from identical packet bytes
  under a registered policy and durable ceilings.

Model judging is not a deterministic pass/fail substitute: the deterministic
assessment remains the criterion, and the judge records the documentation
outcome and utility. Declaring a judge on a `skill-activation` campaign is
rejected by `validate` and `prepare`; docs judging requires a checked
deterministic assessment first.

A selection is accepted only through one checked reader shared by judge,
status, closure and reporting: attempt set, packet bytes, policy hash,
judgement hash, outcome/utility and the judged mutation state are re-derived.
Slot and attempt packet bytes are hashed and compared with the registered
identity and with the packet reconstructed from current evidence.
Judge and recovery claims live under `campaign root/evidence`; a recovery
settles both, and an interrupted claim stays visible and blocks closure. A
terminal publication — attempt evidence, claim closure, ledger event and
selection — is one admission-locked state, so a concurrent close never sees a
judged verdict with no selection. The judge's standing-permission block comes
from the pristine prepared workspace, never the trial's live `AGENTS.md`.
Before dispatch, the executing artifact hash is compared with the freeze,
derived from the executing module's own `src`/`dist` tree, so changed code
under the same package version is refused.

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

## Stability

One npm package, one binary. Version `0.x` is a pre-1.0 line: a minor release
may change documented behaviour, and such changes are listed in the release
notes (`docs/release-<version>.md`) with migration steps.

- **CLI.** Command names, the flags documented by `otc --help`, and exit codes
  (`0` ok, `1` operational refusal, `2` usage/validation refusal) are the
  supported surface. A flag a command does not define is a usage error, not an
  ignored extra. JSON output documents carry their own `schemaVersion`.
- **JavaScript API.** Named ESM exports from the package root are supported for
  programmatic use; there is no default export and no implicit singleton. The
  checked evidence readers (`checkedAssessments`, `checkedSelection`,
  `judgeStateOf`) are the supported way to read evidence, with their exported
  types. A deprecated export keeps working for the life of its release line and
  names its replacement in a `@deprecated` tag; `readAssessments` is deprecated
  in favour of `checkedAssessments`.
- **Evaluator analysis.** The docs analysis modules under
  `src/evaluators/docs/analysis` are exported so recorded evidence can be
  replayed. Their output follows the recorded schema versions, and historical
  replay keeps the semantics of the version that recorded it.
- **Assets.** `examples/`, `container/` and `docs/` ship inside the tarball.
  Installed consumers should address them through the package directory
  (`"$(npm root)/@markstanden/opencode-test-container"`), never through a
  checkout-relative path.

Node 26 is required (`engines`); rootless Podman is required only for lanes
that dispatch a container.

## Development

See [AGENTS.md](AGENTS.md) and [TESTING.md](TESTING.md). The real-container
smoke suite is the standalone gate and needs no sibling docs checkout:

```sh
npm ci
npm run typecheck
npm test
npm run test:smoke
```

The product-specific offline rehearsals remain optional integration evidence:

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
