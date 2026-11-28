# AGENTS.md

Repo notes for agents. The managed `defined` block below owns the gate
verdict; run `defined comply` after a coherent set of edits.

## What this is

`@markstanden/opencode-test-container` (`otc`): an isolated test sandbox for
OpenCode plugins, skills and agent instructions. Source is strict TypeScript
under `src/`; tests are Node's built-in runner under `tests/`; the offline
real-adapter rehearsal lives under `rehearsals/` and is never part of
`npm test`.

## Structure

- `src/contracts` — versioned suite/campaign schemas, identities, validation.
- `src/campaign` — prepare, freeze, ledger, run, assess, close, status.
- `src/evidence` — reserved for evidence readers as they grow.
- `src/adapters/opencode` — configuration, argv, event decoding.
- `src/adapters/podman` — image pinning, mount plans, process boundary.
- `src/evaluators/docs` — signed journal verification and docs grading.
- `src/evaluators/skills` — deterministic activation criteria.
- `src/reporting` — derived reports.
- `src/legacy` — explicit readers for frozen prod014 records.
- `src/cli` — thin command handlers.

Core must not import a docs plugin checkout, require a docs lake or assume A/B,
eight pairs, a judge or a particular provider. Evaluators consume checked
evidence through explicit interfaces. A campaign manifest never names an
executable.

## Reads, calculations and owned effects

Name a function for what it owns. `parseLedger(text)` is a calculation; it
cannot touch a path. `readLedger(root)` acquires one stored observation and
returns the recorded value with its explicit state. `appendLedgerEvent(root,
event)` is a command and returns the resource it created. A receipt is either
stored (a file that is read) or derived (a value computed from checked facts
plus explicit time); a read never invents a missing stored receipt. Commands
may return a handle, and the caller threads that handle onward — a stale
handle does not authorise releasing or advancing a newer owner's resource. A
command that stages temporaries owns their creation and cleanup, or takes a
caller-owned directory and documents it.

Pure calculation modules are listed in `tests/unit/purity-boundary.test.ts`.
Start there before adding clock, environment, randomness or I/O to a module
that claims to calculate.

## Testing

- Node's runner, `node --test`; assertions from `node:assert/strict`.
- Tests are `.ts` and import `src/**/*.ts` directly under Node
  type-stripping; `tsc` rewrites extensions only when building `dist/`.
- Hermetic: `mkdtempSync` directories, test-owned process fixtures, no ambient
  Git config, no network, no credentials, no real Podman/OpenCode in `npm test`.
- The installed-package test runs `npm pack` and installs into a temporary
  consumer; it must keep passing without repository-relative paths.
- Bug fixes ship a test that fails against the pre-fix code.
- The offline rehearsal is a separate command and may use Podman; it uses a
  loopback scripted provider and never a real provider key.

## Verifying

```sh
npm ci
npm test          # build, then node --test
npm run typecheck
defined comply    # the verdict — bootstrap, repair and verify
npm run rehearse:offline   # manual, real adapters, no paid calls
```

Read the gate's JSON errors instead of re-running tools by hand; review repairs
with `git diff`, commit them, then verify the resulting SHA. Do not weaken a
check to get green.

## Knowledge

Architecture and ownership decisions: `docs/architecture.md`. Schema and
migration table: `docs/schema.md`. Rehearsal evidence:
`docs/offline-rehearsal.md`.
<!-- defined:start -->

This project is gated by Mark's portable defined gate. Run `defined comply` —
bootstrap, repair and verify in one pass. (`defined verify` is the
pipeline-only read-only check; `defined scan` is the install-less read-only
check that never adopts — no seed files, managed workflow or AGENTS block.)
A missing ecosystem skips; a missing tool fails loudly.

**When to run it.** After a coherent set of edits, before committing or
handing work back. One run after a batch beats one per file.

**Reading the result.** Every result verb prints one compact JSON line:
`status` and actionable `errors` — read the errors instead of re-running tools
by hand; `--full` adds the per-check `results` map on a first, contextual run.

**After a run.** `git diff`: repairs are real edits to your tree. Fix
findings, then rerun — do not repeat an unchanged failing command. If a check
could not run at all, report the failing step and its error rather than
retrying it as-is. Do not weaken or disable a check just to get green — fix
the finding or raise it upstream.

**What the gate owns.** Bootstrap seeds house defaults (`.editorconfig`,
`.gitattributes`, `Directory.Build.props`) that this project then owns, and
manages plumbing (the CI workflow and this block), realigned on each run.
Edit the seeded defaults here as you wish; raise changes to managed files and
house standards upstream — never fork them locally.

**Public APIs are documented.** Doc comments carry purpose, parameters,
returns, constraints — never name-restating filler; small, well-named private
helpers need no block. The gate proves the sections exist; reviewers prove
the words match (`defined explain jsdoc/require-jsdoc`).

**Knowledge is documented.** Sectioned docs under `docs/`:
`Area`/`Keywords`/`Summary` front-matter, `Date` derived from git, claims
grouped Facts / Inferred / Tested / Open questions. Convention and scrub
checklist: `standards/documentation.md`.

**Looking things up.** `defined explain <step-or-rule>` serves house guidance
from the pinned image — offline, no repo writes, matched to the revision that
gates you; prefer it over reading the upstream repository. House standards:
`standards/` (tests, naming, API documentation, shell, YAML) and
`practices/architecture.md`. Tighten the floor; don't fork it.
<!-- defined:end -->
