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
4. **Check the workspace.** Open the prepared workspace and confirm the files
   the prompt depends on are there. Verify instructions have no collision: a
   fixture `AGENTS.md` plus an instruction targeting `AGENTS.md` is refused.
5. **Check spend.** `budgets.trials` may not exceed the slot count.
   `timeoutMs` should sit above the slowest trial you have seen; a timeout is
   invalid evidence. For a real route, estimate requests per trial, not per
   campaign.
6. **Check the provider.** A scripted route needs its loopback server listening
   and `network: "host"`. A real route needs a real `provider/model`, an overlay
   for routing only, and credential **names** in `passthroughEnv`. No secret
   values in campaign JSON; the validator rejects credential-shaped option keys.
7. **Use a fresh root.** `prepare` refuses an existing root. Editing a campaign
   and reusing its root is a different experiment pretending to be a retry.
8. **Dry-run the plan.** `otc run --root <root> --dry-run` and read mounts,
   image id, argv and environment names before paying for anything.
9. **Freeze once.** Use two repetitions only for a scripted fixture; use three
   for a real model unless the budget forbids it, and record that compromise.

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
5. **Read the rate, if used.** Passing repetitions ÷ valid repetitions. Do not
   count the explicit-invocation control; it proves reachability.
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

| Symptom                                                           | Likely cause and fix                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `defined: image … unavailable` (gate)                             | the pinned image is not cached and the host is offline; report the failing step, do not weaken the gate |
| `prepare` refuses the root                                        | the directory exists; use a fresh root                                                                  |
| `instruction <id> collides with <as>`                             | fixture or `files` already created that path; supersede via `files` or drop the fixture file            |
| `campaign.budgets.trials may not exceed the scheduled slot count` | count slots, then set `trials` at or below it                                                           |
| unexpected field on a `skill-trigger` case                        | e.g. `primaryCheck` or `truth`; the kind does not accept it                                             |
| a skill-activation suite rejected for case kinds                  | the suite mixes `docs-task` and `skill-trigger`; split the suites                                       |
| every trial invalid                                               | provider not reachable, wrong port, or `network` not `host`                                             |
| activation `unknown`                                              | failed target load or unusable capture; read the reasons in the assessment                              |
| image resolve fails at `freeze`                                   | wrong tag, or Podman cannot pull/build; check the pinned identity                                       |
| closure refused                                                   | unresolved claim, unassessable trial, untrustworthy assessment or pending judgement                     |
| admission lock reported held                                      | verify the recorded pid is gone before removing that exact lock; never auto-delete                      |
| judge verdict missing                                             | deterministic assessment missing, judge dispatches exhausted, or a terminal failure class               |
| docs write "missing"                                              | the plugin is not staged, the journal mount is absent, or the prompt produced no call                   |

When a refusal message is unclear, read the source of truth for that stage
(`src/contracts/validate.ts`, `src/campaign/run.ts`, `src/campaign/close.ts`)
rather than retrying the command unchanged.
