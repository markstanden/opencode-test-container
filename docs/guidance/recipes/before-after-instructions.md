# Before/after instructions

Two arms that differ in one always-loaded guidance file, every other input
frozen. Use it to ask whether a changed `AGENTS.md` (or a pointer line) moves
behaviour, without touching your live configuration.

This recipe needs a real provider; the comparison is about model behaviour.
The same skeleton works for a description change by swapping the skill path
between arms instead of the instruction path.

## Shape

```json
{
    "subjects": [
        {
            "armId": "before",
            "skills": [
                { "id": "add-installer", "path": "skills/add-installer" }
            ],
            "instructions": [
                { "id": "guidance", "path": "arms/before/AGENTS.md" }
            ]
        },
        {
            "armId": "after",
            "skills": [
                { "id": "add-installer", "path": "skills/add-installer" }
            ],
            "instructions": [
                { "id": "guidance", "path": "arms/after/AGENTS.md" }
            ]
        }
    ],
    "schedule": {
        "kind": "explicit",
        "slots": [
            {
                "slotId": "before-pos-r0",
                "caseId": "positive-brew-install",
                "armId": "before",
                "repetitionId": "r0"
            },
            {
                "slotId": "before-pos-r1",
                "caseId": "positive-brew-install",
                "armId": "before",
                "repetitionId": "r1"
            },
            {
                "slotId": "before-pos-r2",
                "caseId": "positive-brew-install",
                "armId": "before",
                "repetitionId": "r2"
            },
            {
                "slotId": "after-pos-r0",
                "caseId": "positive-brew-install",
                "armId": "after",
                "repetitionId": "r0"
            },
            {
                "slotId": "after-pos-r1",
                "caseId": "positive-brew-install",
                "armId": "after",
                "repetitionId": "r1"
            },
            {
                "slotId": "after-pos-r2",
                "caseId": "positive-brew-install",
                "armId": "after",
                "repetitionId": "r2"
            }
        ]
    },
    "budgets": { "trials": 6, "judgeAttempts": 0 }
}
```

Each arm's instructions are copied into its trial workspace as `AGENTS.md`
(the default `as`). They resolve against the campaign document. Nothing is
merged: if the case fixture already ships `AGENTS.md`, either remove it from the
fixture or supersede it with a `case.files` entry, because an instruction
targeting an existing path is refused. See
[`staging-and-visibility.md`](../staging-and-visibility.md).

Keep the skill bundle identical in both arms when the treatment is the
instruction, and vice versa. One difference per comparison, or the result has
no owner.

## Run

Use separate roots per arm if you want disjoint `--slot` selection, or one root
for the whole schedule:

```sh
otc validate --campaign campaign.json
otc prepare  --campaign campaign.json --root /tmp/otc-ab
otc freeze   --root /tmp/otc-ab
otc run      --root /tmp/otc-ab
otc assess   --root /tmp/otc-ab
otc close    --root /tmp/otc-ab
otc analyse  --root /tmp/otc-ab --out /tmp/otc-ab-report
```

`otc run` is sequential inside one root. Throughput is bought by preparing
several roots from the same campaign and selecting disjoint slots with
`--slot`; the frozen schedule keeps the split enumerable.

## Verify the treatment actually arrived

Before reading outcomes, prove isolation:

1. Compare `<root>/evidence/trials/<slot>/workspace/AGENTS.md` with the arm's
   file; they should be byte-identical.
2. Compare the staged
   `<root>/evidence/trials/<slot>/config-home/opencode/skills/add-installer/SKILL.md`
   with the source bundle.
3. If both arms carry the same bytes, the treatment never differed — stop.

A live box can carry the new text while both trials carry the old, so never
verify by reading your own `~/.config`.

## Reading the comparison

Group report rows by `armId` and `caseId`; compare pass rates per case, not
campaign totals. A campaign total hides a regression in one case behind a gain
in another. Run the before arm first and record that order, or it becomes an
unmeasured variable.

Watch validity before behaviour: `unknown`/`invalid` trials are not evidence
that the guidance did nothing. A crash, timeout or failed target load is
non-evidence, and an invalid capture must not be counted as a refusal.

## Expected evidence

- Two valid workspace instructions per slot, byte-identical to their arm.
- Per-slot assessments and report rows distinguishing `armId` and
  `repetitionId`.
- A before/after pass-rate delta per case with the sample size beside it.

Measured throughput for a 132-trial, 22-case × 3 × 2 campaign was about 17
minutes wall-clock across six roots, average 41.5 s per trial, with one invalid
capture. Prompt depth dominates duration; freeze `timeoutMs` above the slowest
seen trial.

## What it does not prove

- Causality beyond the sampled cases, especially with three repetitions.
- That a behavioural difference is an improvement: the criterion must encode
  what "better" means before the run.
- Anything about a different model, image or guidance file.

Next: docs evidence —
[`docs-recording.md`](docs-recording.md).
