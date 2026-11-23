# SonarCloud analysis

Wired 2026-11-23. Supersedes the 2026-11-19 note that this repository was
"configured, but not wired".

## Facts

- The SonarCloud project is `markstanden_opencode-test-container` in
  organisation `markstanden`. `.github/workflows/sonarqube--scan.yml` is the
  only producer of a CI analysis, and `sonar-project.properties` is the only
  place its scope is declared.
- This project uses SonarCloud's **whole-project scope**. The scanner reports
  `sonar.sources` and `sonar.tests` as having no effect, so the properties file
  declares neither; `src`, `tests`, `rehearsals`, `examples`, `scripts` and
  `.github` are all analysed, including the workflow security rules. The only
  exclusion is `tests/fixtures/**`, which is captured campaign evidence rather
  than code.
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
  2026-11-23 it measured 92.3% line, 82.4% branch and 93.7% function coverage
  of `src`.
- Automatic Analysis was still enabled on the first CI attempt
  (2026-11-23 08:03), and the scanner refused with "You are running CI analysis
  while Automatic Analysis is enabled". It must be off (project →
  Administration → Analysis Method) for this workflow to run.

## Inferred

- Whole-project scope is the whole-project truth for this repository: the
  rehearsal and script findings from the Automatic Analysis runs are in scope
  by decision, not by accident. The first clean analysis reports 180 issues:
  31 vulnerabilities, 23 bugs, 126 code smells.
- Test files are analysed in the same scope as `src`. Whether SonarCloud also
  classifies `tests/**` as test code (and so keeps it out of the coverage
  metric) is unproven until a CI analysis imports `coverage/lcov.info`; if
  coverage lands around 60% rather than ~92%, the tests are being counted as
  source and want a coverage exclusion.
- The gate judges new code only, so the 180 pre-existing issues do not fail
  the wiring pull request; they are cleanup work in their own right (the 22
  `S2871` sort comparators and 5 `S5443` temp-directory findings are genuine
  correctness and security items, not style).

## Tested

- Local `npm run test:coverage` passes every declared floor and writes
  `coverage/lcov.info`; `defined comply` reports compliant with the workflow
  and properties file.
- The first CI analysis imported no coverage and failed on the Automatic
  Analysis conflict, so no scoped analysis of this repository has run yet.

## Open questions

- Does the first CI analysis classify `tests/**` as test code, or must coverage
  exclusions compensate?
- Is 100% of the security hotspots reviewable without silencing real risk?
