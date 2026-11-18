# Add-installer recipe: a skill-activation suite

A worked `skill-trigger` suite for a skill that adds a package installer, say
`add-installer`. The mechanics are the same for any skill: pick five case
shapes, stage a realistic fixture for at least one of them, and repeat each case
enough times to see past one lucky answer.

The suite decides that a skill was chosen. It does not decide that the installer
it wrote is correct — that needs a task-result evaluation OTC does not provide
for skill cases, as
[`choose-what-youre-measuring.md`](choose-what-youre-measuring.md) explains.

## The five cases

Write all five before tuning the description. Each answers a different
question, and dropping one lets a bad description look good.

| Case                        | Prompt shape                                                   | `expected`      | What a pass establishes                                         |
| --------------------------- | -------------------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| Natural positive            | Describes the need; never names the skill or says "installer". | `activation`    | The description triggers from intent, not from its own wording. |
| Paraphrase                  | Same need, different vocabulary, casual or abbreviated.        | `activation`    | Triggering is not a single keyword match.                       |
| Near-miss                   | Shares vocabulary but needs an adjacent capability.            | `no-activation` | The description's boundary is stated well enough to hold.       |
| Unrelated                   | An ordinary task the skill cannot help with.                   | `no-activation` | The skill is not always on.                                     |
| Explicit-invocation control | Names the skill and asks for what it does.                     | `activation`    | The skill can be loaded at all. Report it separately.           |

The control is not a trigger test. It confirms the bundle, id and staging are
sound, so a red campaign can distinguish "the description never fires" from
"the skill was never reachable". Never count it in a trigger rate.

Worked prompts for `add-installer`:

```jsonc
{ "prompt": "People keep asking how to get the CLI onto their laptops without cloning the repo. Can we make that a one-liner?" } // natural positive
{ "prompt": "whats the easiest way for the team to grab this tool on macOS" }                                                          // paraphrase
{ "prompt": "Add a Makefile target that runs the install script in CI." }                                                               // near-miss
{ "prompt": "Rename the local variable total to subtotal." }                                                                            // unrelated
{ "prompt": "Use the add-installer skill to add a Homebrew formula." }                                                                  // control
```

Keep the positives non-obvious: a prompt that already asks for exactly what the
skill does would trigger under any description and proves nothing. Keep the
near-miss credible: it should share the word "install" and still need something
else. Strip the file paths and personal context out and the suite measures a
description against text no user writes.

## A fixture-bearing case

A case with a `fixture` runs against a workspace that looks like the repository
where the skill would really fire. `fixture` is a directory copied into the
trial workspace; it resolves against the **suite document**, not the campaign.
Inline `files` are written after the fixture, relative to the workspace root.
See [`docs/schema.md`](../schema.md) § Path bases for the full table and the
construction-order rule.

```json
{
    "caseId": "positive-brew-install",
    "kind": "skill-trigger",
    "targetSkillId": "add-installer",
    "expected": "activation",
    "prompt": "People keep asking how to get the CLI onto their laptops without cloning the repo. Can we make that a one-liner?",
    "fixture": "fixtures/cli-tool",
    "files": {
        "README.md": "# cli-tool\n\n## Install\n\nTODO: document installation.\n"
    }
}
```

```text
suites/installer/
├── suite.json
├── fixtures/
│   └── cli-tool/          # package.json, src/, an honest AGENTS.md
└── campaign.json
```

Use the fixture to supply the real signals a model reads: a `package.json` with
a `bin` entry, a README whose install section is `TODO`, and any project
conventions. Keep it small; the fixture is copied for every repetition.

If the fixture already ships `AGENTS.md`, an arm `instructions` entry targeting
`AGENTS.md` is refused — see
[`staging-and-visibility.md`](staging-and-visibility.md). Supersede it with a
`files` entry or leave it out of the fixture.

## Repetitions

A repetition is another **slot**: same `caseId` and `armId`, different
`repetitionId`, unique `slotId`. `repetitionId` is an opaque string; nothing
parses it. The schedule is always explicit, so repetitions are data, not a
multiplier:

```json
{
    "schedule": {
        "kind": "explicit",
        "slots": [
            {
                "slotId": "s1",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r0"
            },
            {
                "slotId": "s2",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r1"
            },
            {
                "slotId": "s3",
                "caseId": "positive-brew-install",
                "armId": "skill-only",
                "repetitionId": "r2"
            }
        ]
    }
}
```

Rules that follow:

- **Three repetitions per case** is the working default for a real model.
  Model behaviour is nondeterministic; one trial is an anecdote.
- `budgets.trials` must cover the slots you intend to run and may not exceed the
  scheduled slot count. A lower budget leaves slots legitimately `unrun`.
- A **trigger rate** is passing repetitions ÷ run repetitions for one case.
  OTC records a pass or fail per slot in `evidence/assessments/<slotId>.json`
  and a slot table in the report; it does not compute the rate for you. Treat a
  positive as passing above 0.5 and a negative below 0.5, then read every
  near-threshold case before changing the description.
- A scripted provider answers the same way every time. Repetition costs nothing
  there, but it proves wiring and scoring, not model choice.

Five cases × three repetitions is 15 slots. Grow towards roughly 20 cases
(8–10 positives, 8–10 negatives) only when you are tuning a description in
earnest; the five shapes above are the minimum honest suite.

## Expected evidence

With the shipped `otel-helper` example, a scripted run passes all three slots:

| Slot | Case                | Observed            | Outcome |
| ---- | ------------------- | ------------------- | ------- |
| `s1` | positive-instrument | `target-activation` | pass    |
| `s2` | negative-unrelated  | `no-invocation`     | pass    |
| `s3` | negative-near-miss  | `no-invocation`     | pass    |

Observed values you can meet: `target-activation`, `other-skill-only`,
`no-invocation`, `failed-target-load` (unknown, never a passing negative) and
`unrun`. A non-skill tool reading the body is contamination evidence: with the
default `contamination: "fail"` the assessment becomes invalid, not a pass
through the back door.

[`recipes/scripted-skill-activation.md`](recipes/scripted-skill-activation.md)
runs this suite end to end.

## What this does not prove

- Activation is not task success. The installer may still be wrong.
- A scripted plan stands in for the model; a real-provider campaign is the only
  one that measures the description.
- Configuration validation proves shape, references and cross-references. It
  never proves the cases measure what you intend.

## Next

- Where the fixture, subjects and instructions land:
  [`staging-and-visibility.md`](staging-and-visibility.md).
- Repetitions against a real provider:
  [`recipes/trigger-rate-with-repetitions.md`](recipes/trigger-rate-with-repetitions.md).
- Before/after guidance arms:
  [`recipes/before-after-instructions.md`](recipes/before-after-instructions.md).
