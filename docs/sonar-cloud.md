# SonarCloud: configured, but not wired

Observed 2026-11-19 while bumping the `defined` gate pin.

## Facts

- The repository carries a root `sonar-project.properties` (7 non-empty lines),
  but SonarCloud has no project for it. `api/project_analyses/search` and
  `api/qualitygates/project_status` both answer
  `Component key 'markstanden_opencode-test-container' not found`.
- No workflow under `.github/workflows` runs a Sonar scan or posts to
  SonarCloud, and `api/ce/activity` for a pull request in this repository
  returns zero tasks.
- `pr-prep.sh sonar-check` therefore reports `pending` for a PR here, and
  `sonar-issues` has no list to return. Neither is lag: nothing arrives by
  waiting.
- On PR #7 (a one-line `.defined.json` gate pin bump, merged as `e258140`) the
  verdict rested on GitHub checks alone: `defined-gate` on both the
  `pull_request` and `push` events, plus the "Real containment smoke" workflow.
  Four runs, all successful.

## Inferred

- The properties file is aspirational. A project must be created in
  SonarCloud and a scan step added to a workflow before any analysis exists.
  Until then Sonar is not part of this repository's gate, however much the
  config file implies otherwise.
- A `sonar-check` read of `pending` here means "no Sonar analysis for this
  project". It should be reported as such and never waited on, and never read
  as a failing gate.

## Tested

- Two independent API reads (`project_analyses/search`,
  `qualitygates/project_status`) plus the CE activity queue agree: no project,
  no analysis, no queued task. PR #7 went green from the GitHub checks with no
  Sonar run at all.

## Open questions

- Delete `sonar-project.properties`, or create the SonarCloud project and wire
  a scan? Both are product decisions, deliberately not taken during a gate
  bump.
- If a scan is wired, should its verdict be a required read in the PR flow?
  This repository is private on a free plan, so branch protection and required
  status checks are unavailable.
