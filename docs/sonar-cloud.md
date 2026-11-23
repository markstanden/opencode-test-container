# SonarCloud analysis

Wired 2026-11-23. Supersedes the 2026-11-19 note that this repository was
"configured, but not wired": the project exists, the scan runs in CI, and the
quality gate now has a verdict.

## Facts

- The SonarCloud project is `markstanden_opencode-test-container` in
  organisation `markstanden`. `sonar-project.properties` owns its scope:
  `sonar.sources=src`, `sonar.tests=tests`, `tests/fixtures/**` excluded as
  captured evidence rather than code, and `sonar.javascript.lcov.reportPaths`
  pointed at `coverage/lcov.info`.
- Automatic Analysis is off (SonarCloud → Administration → Analysis Method).
  `.github/workflows/sonarqube--scan.yml` is therefore the only producer of an
  analysis, and the only path on which the properties file takes effect.
- The workflow runs on pushes to `main`, every pull request and
  `workflow_dispatch`: `ubuntu-26.04`, Node 26, `npm ci --ignore-scripts`,
  `npm run test:coverage`, then `SonarSource/sonarqube-scan-action` pinned at
  `ba9859ea…` (v8). `SONAR_TOKEN` is a dedicated project analysis token stored
  as a repository secret (set 2026-11-23).
- `sonar.qualitygate.wait=true` makes a red gate fail the `SonarQube` job, not
  merely decorate the pull request. The SonarCloud GitHub app posts a separate
  `SonarCloud Code Analysis` check.
- The default `Sonar way` gate judges new code only: reliability, security and
  maintainability rating A, coverage at least 80%, duplicated lines density at
  most 3%, security hotspots 100% reviewed.
- `package.json:test:coverage` runs the whole suite through `node --test`'s
  lcov reporter and enforces the repository's own declared floors. On
  2026-11-23 it measured 92.3% line, 82.4% branch and 93.7% function coverage.

## Inferred

- The first analysis of the branch is also its new-code baseline: all ~30k
  lines of `src` count as new code, so the gate's coverage, duplication and
  rating thresholds are measured against the whole runtime. Baseline coverage
  clears the 80% threshold; duplication and hotspots are the unknown.
- A `SonarCloud Code Analysis` check beside the `SonarQube` job is expected on
  pull requests, because the GitHub integration already decorates the other
  projects in the organisation.
- `pr-prep.sh sonar-check` should now read a real verdict for a pull request
  here instead of the `pending` that meant "no project, no analysis".

## Tested

- Local `npm run test:coverage` passes every declared floor and writes
  `coverage/lcov.info`; `defined comply` reports compliant with the new
  workflow and properties file.
- CI evidence (first analysis verdict, coverage measure, PR decoration) is
  recorded when the workflow first runs; it is not yet observed.

## Open questions

- Does the first analysis pass the gate, or does it need hotspot review and
  finding triage before it can be green?
- Should the `SonarCloud Code Analysis` check become a required status check?
  The repository is public, so branch protection and required checks are
  available — unlike when the earlier note was written.
