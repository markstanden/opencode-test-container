# Choose what you are measuring

OTC checks that your configuration is well formed and scores the evidence it
captures. It cannot know whether your cases measure the behaviour you care
about. Pick the question first, then the supported mechanism.

| Question                                               | Supported approach                                             | What a pass establishes                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Does this request activate the target skill?           | `skill-trigger` with `expected: "activation"`                  | The target skill was loaded in a usable capture.                            |
| Does an unrelated request avoid activation?            | `skill-trigger` with `expected: "no-activation"`               | No target activation in a usable capture.                                   |
| Does activation work in a representative repo context? | a skill case with a `fixture`                                  | Activation under that supplied context.                                     |
| Does the skill produce a correct installer?            | a task-result evaluation — not available for skill cases today | Activation alone is insufficient.                                           |
| Does the docs plugin record appropriately?             | `docs-task` with declared expectations                         | Verified operations and deterministic criteria.                             |
| Is the resulting documentation useful?                 | optional docs judge                                            | A separate semantic judgement; it does not replace the deterministic check. |

Two rules worth repeating:

1. Successful configuration validation does not establish that the experiment
   measures the intended behaviour. `otc validate` proves shape, references and
   cross-references, nothing more.
2. Successful skill loading does not establish successful task completion. A
   captured skill load is evidence that the skill was chosen in that trial, not
   that the work it guided was correct.

## Limits that follow

- **`primaryCheck` is a docs-task field.** A skill-trigger case cannot declare
  one; the validator rejects it with an unexpected-field problem. A skill
  activation campaign can show that the skill was chosen, but proving the
  installer it produced is correct needs a task-result evaluation that OTC does
  not currently provide for skill cases. Do not add an unsupported field in the
  hope it is ignored — it stops validation instead.
- **Scripted providers prove wiring and scoring.** A scripted response plan
  exercises OTC's staging, capture decoding and assessment. It says nothing
  about how a real model chooses skills.
- **The judge is optional and semantic.** It records documentation outcome and
  utility from an arm-blind packet; the deterministic assessment remains the
  criterion.

## Next

- A worked skill-activation suite: [`add-installer-recipe.md`](add-installer-recipe.md).
- Where files land and what the trial sees:
  [`staging-and-visibility.md`](staging-and-visibility.md).
- Executable configurations with expected evidence: [`recipes/`](recipes/).
