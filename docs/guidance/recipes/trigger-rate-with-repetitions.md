# Trigger rate with repetitions

The same five-shape suite from
[`add-installer-recipe.md`](../add-installer-recipe.md), run three times per
case against a real provider. This is the recipe that measures a description;
the scripted one only measures the harness.

Start from [`examples/skills`](../../../examples/skills) and change two things:
the provider route and the schedule.

## Provider route

Replace the example's loopback overlay with your own route. The route label is
a human label; `model` must be a real `provider/model` in OpenCode's catalogue,
and the overlay carries only non-secret routing.

```json
{
    "runtime": {
        "image": "localhost/otc-sandbox:2.2.6",
        "opencodeVersion": "2.2.6",
        "provider": {
            "route": "host-proxy",
            "model": "opencode-go/deepseek-v4.1-flash",
            "overlay": {
                "providers": {
                    "opencode-go": {
                        "settings": {
                            "baseURL": "http://127.0.0.1:8788/w/opencode/compat/opencode-go/v1"
                        }
                    }
                }
            }
        },
        "timeoutMs": 300000,
        "network": "host",
        "passthroughEnv": ["OPENCODE_API_KEY"]
    }
}
```

The base URL above is a host-proxy example, not a requirement: point it at
whatever route you actually use. Only the **name** `OPENCODE_API_KEY` is
declared; its value is copied from your environment into a `0600` trial env
file. `timeoutMs` is per trial and must sit above the slowest trial you have
seen — a timeout is invalid evidence, so a tight budget burns the trial.

## Schedule

Three repetitions per case, explicit:

```json
{
    "schedule": {
        "kind": "explicit",
        "slots": [
            {
                "slotId": "pos-r0",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r0"
            },
            {
                "slotId": "pos-r1",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r1"
            },
            {
                "slotId": "pos-r2",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r2"
            },
            {
                "slotId": "near-r0",
                "caseId": "negative-near-miss",
                "armId": "skill-only",
                "repetitionId": "r0"
            },
            {
                "slotId": "near-r1",
                "caseId": "negative-near-miss",
                "armId": "skill-only",
                "repetitionId": "r1"
            },
            {
                "slotId": "near-r2",
                "caseId": "negative-near-miss",
                "armId": "skill-only",
                "repetitionId": "r2"
            }
        ]
    },
    "budgets": { "trials": 6, "judgeAttempts": 0 }
}
```

`repetitionId` is opaque; the slot id is what evidence and reports name.
`budgets.trials` may equal or undercut the slot count, never exceed it.

## Run

Use a fresh root per campaign, not per repetition:

```sh
export OPENCODE_API_KEY=...
otc validate --campaign campaign.json
otc prepare  --campaign campaign.json --root /tmp/otc-rate
otc freeze   --root /tmp/otc-rate
otc run      --root /tmp/otc-rate --dry-run   # read the plan before paying
otc run      --root /tmp/otc-rate
otc assess   --root /tmp/otc-rate
otc close    --root /tmp/otc-rate
otc analyse  --root /tmp/otc-rate --out /tmp/otc-rate-report
```

To parallelise, prepare several roots from the same campaign and select
disjoint slots with `--slot`; the schedule stays frozen per root, so the split
stays enumerable.

## Reading the rate

OTC scores each slot; it does not aggregate a rate. Derive it from the published
report, which is checked output rather than raw evidence:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
const { slots } = JSON.parse(readFileSync("/tmp/otc-rate-report/report.json", "utf8"));
const byCase = new Map();
for (const slot of slots) {
    const bucket = byCase.get(slot.caseId) ?? { pass: 0, run: 0 };
    if (slot.validity === "valid") {
        bucket.run += 1;
        if (slot.outcome === "pass") bucket.pass += 1;
    }
    byCase.set(slot.caseId, bucket);
}
for (const [caseId, b] of byCase) console.log(`${caseId}: ${b.pass}/${b.run}`);
'
```

A positive passes above 0.5 and a negative below it. With three repetitions that
is `2/3` versus `1/3`. Do not count the explicit-invocation control: it proves
reachability, not triggering. Read every case sitting on the threshold instead
of declaring victory.

A trigger rate needs a sample, not a campaign: if you are tuning a description,
grow towards 20 cases (8–10 positives, 8–10 negatives) before treating a delta
as real.

## Expected evidence

- One valid assessment per run slot under `evidence/assessments/<slotId>.json`.
- `report.json` slot rows carrying `caseId`, `repetitionId`, `observed`,
  `validity` and `outcome`.
- `unknown` or `invalid` rows are non-evidence. A failed target load makes the
  activation unknown rather than a passing negative, and a truncated capture is
  invalid rather than a restraint.

## What it does not prove

- That the cases represent real requests beyond the queries you wrote.
- That activation produced correct work — see
  [`add-installer-recipe.md`](../add-installer-recipe.md).
- Anything about cost per trial beyond the budget you froze.

Next: compare two guidance variants —
[`before-after-instructions.md`](before-after-instructions.md).
