# Agent checklist

For an agent asked to run an OTC experiment. The goal is not a green command; it
is a result whose claim matches its evidence.

## Before dispatch

1. **Name the question.** Pick the mechanism from
   [`choose-what-youre-measuring.md`](choose-what-youre-measuring.md). If the
   question is "is the installer it wrote correct", stop: skill cases do not
   answer that.
2. **Validate.** `otc validate --campaign <file>`. Read the problems; a valid
   campaign only proves shape and references.
3. **Check paths.** Confirm every `suite.path`, subject path, `fixture` and
   `primaryCheck.directory` exists, with the right base — see
   [`docs/schema.md`](../schema.md) § Path bases. A fixture is relative to the
   suite, not the campaign.
4. **Check spend and repetitions.** `budgets.trials` may not exceed the slot
   count. `timeoutMs` should sit above the slowest trial you have seen; a timeout
   is invalid evidence. For a real route, estimate requests per trial, not per
   campaign. Choose the repetition count before `prepare`: two repetitions only
   for a scripted fixture; three for a real model unless the budget forbids it,
   and record that compromise.
5. **Check the provider.** A scripted route needs its loopback server listening
   and `network: "host"`. A real route needs a real `provider/model`, an overlay
   for routing only, and credential **names** in `passthroughEnv`. No secret
   values in campaign JSON; the validator rejects credential-shaped option keys.
6. **Use a fresh root.** `prepare` refuses an existing root. Editing a campaign
   and reusing its root is a different experiment pretending to be a retry.
7. **Prepare.** `otc prepare --campaign <file> --root <root>`. This validates,
   then writes the pristine case workspaces (`prepare/workspaces/<caseId>/`) and
   the staged subject payloads (`prepare/subjects/<arm>/…`).
8. **Inspect what was prepared.** Open the case workspace and confirm the
   fixture and inline `files` the prompt depends on are there. Read each arm's
   instruction bytes under `prepare/subjects/<arm>/instructions/<id>/<as>`.
   Arm instructions are **not** in the case workspace yet — they are copied per
   trial — so a collision cannot be seen at this step.
9. **Freeze once.** `otc freeze --root <root>` resolves and records the image and
   CLI identity. Dry-run and dispatch both require this receipt.
10. **Dry-run the plan.** `otc run --root <root> --dry-run` stages each selected
    slot in a disposable directory, reports an instruction collision if one
    exists, and lists the slots it would dispatch. No container starts, no
    provider request is made and no trial budget is consumed. It prints no
    mounts or argv and keeps no directory, so check those against
    [`docs/schema.md`](../schema.md) and the campaign instead.
11. **Dispatch.** `otc run --root <root>`, then inspect the materialised trial
    workspace under `evidence/trials/<slotId>/workspace/`.

## After the run

1. **Assess before believing.** `otc assess --root <root>`. `run` proves a
   process ran, not that the evidence is usable.
2. **Read validity first.** `unknown` and `invalid` are non-evidence. A failed
   target load is not a passing negative; a truncated capture is not a restraint.
3. **Read observed against expected.** `target-activation`, `other-skill-only`,
   `no-invocation`, `failed-target-load`, `unrun`. Check contamination:
   a non-skill tool reading the skill body is not activation.
4. **Group by case and arm.** A campaign total can hide a regression in one case
   behind a gain in another. Report per-case denominators.
5. **Read the rates, if used.** Activation rate is target activation ÷ valid
   slots (a positive usually wants it high, a negative low). Criterion pass rate
   is passes ÷ valid slots (high is good for both). Use the shipped
   `examples/reporting/rates.mjs`; do not count an explicit-invocation control,
   which proves reachability.
6. **Close and render.** `otc close`, then `otc analyse --out <fresh-dir>`.
   Never hand-edit evidence; never analyse into `evidence/` or `prepare/`.
7. **Status is read-only.** `otc status --root <root> --json` reports counts,
   lock state and next actions. It does not repair, probe or dispatch.

## Reporting

State, in this order:

- the question and the mechanism chosen;
- the cases, with `expected`, `observed`, `validity` and `outcome`;
- the sample size and any `unrun`/`unknown`/`invalid` slots;
- the arm and repetition each result came from;
- what the result does **not** prove, in one sentence.

Never report "all passed" without the observed values, and never present a
scripted run as evidence about model behaviour.

## Troubleshooting

| Symptom                                                           | Likely cause and fix                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `defined: image … unavailable` (gate)                             | the pinned image is not cached and the host is offline; report the failing step, do not weaken the gate                                   |
| `prepare` refuses the root                                        | the directory exists; use a fresh root                                                                                                    |
| `instruction <id> collides with <as>`                             | the fixture or `case.files` already created that path; remove it from both, or drop the arm instruction. Inline files cannot supersede it |
| `campaign.budgets.trials may not exceed the scheduled slot count` | count slots, then set `trials` at or below it                                                                                             |
| unexpected field on a `skill-trigger` case                        | e.g. `primaryCheck` or `truth`; the kind does not accept it                                                                               |
| a skill-activation suite rejected for case kinds                  | the suite mixes `docs-task` and `skill-trigger`; split the suites                                                                         |
| every trial invalid                                               | provider not reachable, wrong port, or `network` not `host`                                                                               |
| activation `unknown`                                              | failed target load or unusable capture; read the reasons in the assessment                                                                |
| image resolve fails at `freeze`                                   | wrong tag, or Podman cannot pull/build; check the pinned identity                                                                         |
| closure refused                                                   | unresolved claim, unassessable trial, untrustworthy assessment or pending judgement                                                       |
| admission lock reported held                                      | verify the recorded pid is gone before removing that exact lock; never auto-delete                                                        |
| judge verdict missing                                             | deterministic assessment missing, judge dispatches exhausted, or a terminal failure class                                                 |
| docs write "missing"                                              | the plugin is not staged, the journal mount is absent, or the prompt produced no call                                                     |

When a refusal message is unclear, read the source of truth for that stage
(`src/contracts/validate.ts`, `src/campaign/run.ts`, `src/campaign/close.ts`)
rather than retrying the command unchanged.
