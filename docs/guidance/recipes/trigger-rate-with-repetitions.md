# Trigger rate with repetitions

The same `otel-helper` suite as
[`scripted-skill-activation.md`](scripted-skill-activation.md), run three times
per case against a real provider. This is the recipe that measures a
description; the scripted one only measures the harness.

Start from [`examples/skills`](../../../examples/skills) and use its shipped
`campaign-repetitions.json`: nine slots, three repetitions of each of the three
cases. The only thing you change is the provider route.

## Provider route

`campaign-repetitions.json` ships a loopback scripted route. Replace its
`runtime.provider` block with your own. The route label is a human label;
`model` must be a real `provider/model` in OpenCode's catalogue, and the overlay
carries only non-secret routing.

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

The model, base URL, credential name and image above are **your** prerequisites;
this repository has not verified that route. Only the **name**
`OPENCODE_API_KEY` is declared; its value is copied from your environment into a
`0600` trial env file. `timeoutMs` is per trial and must sit above the slowest
trial you have seen — a timeout is invalid evidence, so a tight budget burns the
trial.

## Schedule

The shipped file is the schedule; do not retype it. Three repetitions per case,
explicitly, with `budgets.trials: 9`:

```jsonc
// excerpt: the first three of campaign-repetitions.json's nine slots
{ "slotId": "pos-r0", "caseId": "positive-instrument", "armId": "skill-only", "repetitionId": "r0" }
{ "slotId": "pos-r1", "caseId": "positive-instrument", "armId": "skill-only", "repetitionId": "r1" }
{ "slotId": "pos-r2", "caseId": "positive-instrument", "armId": "skill-only", "repetitionId": "r2" }
```

`repetitionId` is opaque; the slot id is what evidence and reports name.
`budgets.trials` may equal or undercut the slot count, never exceed it. If you
want a smaller run, delete whole repetitions and lower `trials` to match, and
say in the report that it is a subset.

## Run

Use a fresh root per campaign, not per repetition:

```sh
export OPENCODE_API_KEY=...
otc validate --campaign campaign-repetitions.json
otc prepare  --campaign campaign-repetitions.json --root /tmp/otc-rate
otc freeze   --root /tmp/otc-rate
otc run      --root /tmp/otc-rate --dry-run   # plans only; needs the freeze above
otc run      --root /tmp/otc-rate
otc assess   --root /tmp/otc-rate
otc close    --root /tmp/otc-rate
otc analyse  --root /tmp/otc-rate --out /tmp/otc-rate-report
```

To parallelise, prepare several roots from the same campaign and select
disjoint slots with `--slot`; the schedule stays frozen per root, so the split
stays enumerable.

## Reading the rates

OTC scores each slot; it does not aggregate a rate. Derive both rates from the
published report with the shipped summariser, which is the same code the tests
exercise:

```sh
# installed consumer (or $(npm root -g)/@markstanden/opencode-test-container/…)
node node_modules/@markstanden/opencode-test-container/examples/reporting/rates.mjs \
  /tmp/otc-rate-report/report.json

# from a checkout
node examples/reporting/rates.mjs /tmp/otc-rate-report/report.json
```

The output is one row per case **and arm**, so two treatments of the same case
never merge.

Two rates, two questions:

- **Activation rate** = valid slots that observed `target-activation` ÷ valid
  slots. A positive case usually wants this high; a negative case wants it low.
- **Criterion pass rate** = valid slots scored `pass` ÷ valid slots. High is
  desirable for both expectations, because a negative that correctly stays
  quiet is a pass with no activation. Never read a negative's pass rate as its
  trigger rate.

Only valid slots enter either denominator. `invalid`, `unknown` and `unrun`
slots stay visible beside it; they are non-evidence, not failures. With no
valid slot the rate is `unavailable`, never `0%`.

The first three positive slots of the shipped suite give:

| Case                | Arm        | Expected   | Valid | Activation | Pass | Invalid | Unknown | Unrun |
| ------------------- | ---------- | ---------- | ----- | ---------- | ---- | ------- | ------- | ----- |
| positive-instrument | skill-only | activation | 3/3   | 3/3        | 3/3  | 0       | 0       | 0     |

A negative case that stayed quiet in all three would read `0/3` activation and
`3/3` pass. If you adopt a decision rule such as "at least 2 of 3 positives
activate", choose and record it **before** the run: that is an example rule for
this experiment, not a confidence claim and not a built-in OTC threshold. Three
repetitions are a small descriptive sample, not a significance test.

An explicit-invocation control is reported separately and never counted in a
trigger rate. If your suite declares one, name it with
`--control <caseId>` on the summariser; the case schema has no control flag.

A trigger rate needs a sample, not a campaign: if you are tuning a description,
grow towards 20 cases (8–10 positives, 8–10 negatives) before treating a delta
as real.

## Expected evidence

- One valid assessment per run slot under `evidence/assessments/<slotId>.json`.
- `report.json` slot rows carrying `caseId`, `armId`, `repetitionId`,
  `observed`, `validity` and `outcome`.
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
