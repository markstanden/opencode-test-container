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
  by decision, not by accident. The first analysis reported 182 issues (31
  vulnerabilities, 23 bugs, 126 code smells); the cleanup register below pays
  them down.
- SonarCloud classifies `tests/**` as test code automatically: the analysis'
  `lines_to_cover` (30,121) equals the `src` executable-line count exactly, so
  tests neither count as source nor drag the coverage metric.
- The gate judges new code only, so the pre-existing issues could not fail the
  wiring pull request; they were cleanup work in their own right.

## Tested

- Local `npm run test:coverage` passes every declared floor and writes
  `coverage/lcov.info`; `defined comply` reports compliant with the workflow
  and properties file.
- The CI analysis of PR 8 (2026-11-23 08:09) imported that report: 90.9%
  overall coverage (92.3% line, 82.5% branch), 0.8% duplicated lines, gate
  `OK`, zero new-code issues. The `SonarQube` job and the `SonarCloud Code
Analysis` check both pass on the pull request.

## Cleanup register (2026-11-23)

Across the analyses of this work SonarCloud raised 191 issues: the 182 the first
whole-project analysis reported, plus those raised as the cleanup moved code.
The final register is **141 fixed, 50 accepted with a written reason, 0 open**.

- **Fixed — 141 findings.** Deterministic sort comparators (`S2871`), nested
  ternaries and templates (`S3358`, `S4624`), optional chains (`S6582`),
  re-exports and duplicate imports (`S7763`, `S3863`), collection and string
  idioms (`S7750`, `S7765`, `S7770`, `S7776`, `S7778`, `S7781`), character
  classes (`S6353`, `S5869`), `String.raw` (`S7780`), named aliases (`S4323`),
  complexity extractions (`S3776`), and value rendering (`S6551`). This
  includes the five findings the cleanup itself introduced, cleared before the
  follow-up analysis.
- **Hardened — the rehearsal root.** `rehearsals/root.mts` confines the one
  operator-supplied argument to a strict descendant of the system temporary
  directory or the current directory; both bases are refused themselves,
  because the rehearsal deletes its root recursively. The confinement is
  pinned by tests. The taint analyser still reads the sinks, so no `S8707`
  closed; all 20 are in the accepted cohort below.
- **Accepted with a written reason on each issue — 50.** `S8707` (20) the
  residual sink flow for the confined rehearsal root; `S9382` (18) serial loops,
  each reason written for its site: ordered prepare/freeze/run sequences,
  polling waits, request-accounting sequences sharing one scripted provider, and
  one budget-consuming dry-run preview; `S5443` (5) the sandbox container's
  `/tmp` home; `S4036` (2) the operator's `PATH` for `podman`; `S8705` (2)
  shell-free `spawn` with an argument array; `S107` (3) decision-contract
  parameter lists. Two further `S9382` findings retired with the code that
  carried them and are counted as fixed.

Accepted issues do not count toward the quality gate. The repository's own
`defined` gate remains the merge verdict for style and tests.

## Open questions

- Is 100% of the security hotspots reviewable without silencing real risk?
- Should the `SonarCloud Code Analysis` check become a required status check?
  The repository is public, so branch protection and required checks are
  available.
