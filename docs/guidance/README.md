# Guidance for experiment authors

How to design an OTC experiment that measures what you think it measures.
Start with the question, not the JSON.

- [`choose-what-youre-measuring.md`](choose-what-youre-measuring.md) — which
  supported mechanism answers which question, and the limits that follow.
- [`add-installer-recipe.md`](add-installer-recipe.md) — worked skill-activation
  suite with positive, near-miss and explicit-invocation controls.
- [`staging-and-visibility.md`](staging-and-visibility.md) — path bases,
  workspace construction, and what the trial can actually see.
- [`recipes/`](recipes/) — runnable configurations with expected evidence and a
  "what this does not prove" statement.
- [`agent-checklist.md`](agent-checklist.md) — pre-dispatch checks, post-run
  reporting, troubleshooting.

Two rules before anything else:

1. Successful configuration validation does not establish that the experiment
   measures the intended behaviour.
2. Successful skill loading does not establish successful task completion.

Other OTC documentation: [`README`](../../README.md) for the lifecycle,
[`docs/schema.md`](../schema.md) for field semantics and path bases,
[`docs/architecture.md`](../architecture.md) for the evidence boundary.
