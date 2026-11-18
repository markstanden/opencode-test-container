# Release 0.2.0

Status: **release candidate**. This document records the planned release facts
known before publication. Registry evidence exists only after the tag-triggered
workflow runs; it is added to this file after the fact, never predicted.

## What this release is

`0.2.0` is the first minor after the published `0.1.1`. It includes the two
merged changes that `0.1.1` predates, plus this candidate's fixes.

| Fact                     | Value                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proposed version         | `0.2.0`                                                                                                                                                      |
| Base (reviewed `main`)   | `f02d6bda13132115a03e85f6275cf0ae5d5b3e7c`                                                                                                                   |
| Published `0.1.1` source | `60acb33ee12d7cfb13ce512d49474edf04b167d7`                                                                                                                   |
| Included pull requests   | [#3](https://github.com/markstanden/opencode-test-container/pull/3), [#4](https://github.com/markstanden/opencode-test-container/pull/4) and this release PR |
| Publication route        | the existing tag-triggered `.github/workflows/npm--publish.yml` over npm trusted publishing                                                                  |
| Tag owner                | a human, after the agreed candidate is merged                                                                                                                |

`0.1.1` shipped from `60acb33`; the reviewed `main` at `f02d6bd` already
contains #3 (evidence boundaries and the real-container smoke suite) and #4
(consumer guidance and proved examples). Those changes were never published.

## Changes from 0.1.1

### Contracts and evidence

- **Judge eligibility is explicit.** A docs judge requires a checked
  deterministic assessment with a valid capture and a `pass` or `fail`
  outcome. A missing, corrupt, invalid or unknown assessment refuses the whole
  judge invocation before any claim, so it costs zero paid attempts. A valid
  adverse result is eligible. `status`, `judge` and `close` share the same
  decision and reasons.
- **Skill activation cannot declare a judge.** `validate` and `prepare` reject
  `assessment.judge` unless the assessment kind is `docs-recording`.
- **Freeze receipts publish atomically.** Two concurrent freezes cannot both
  succeed with different resolved images. Same-identity callers converge on the
  durable receipt.
- **Frozen inventories are version 2.** Execute bits and empty directories are
  recorded and delivery-checked; staging preserves file permissions. A
  historical manifest without `inventoryVersion` keeps version 1 (content-only)
  comparison semantics.
- **Trial usage is bound.** `meta.json` records `usageSha256`; a changed or lost
  `usage.json` is conflicting or missing evidence, not silently different cost.
  Historical captures without a binding report their usage as unverified.
- **Closed reports carry `usageProblems`.** The accepted figures come only from
  a bound sidecar.

### Lifecycle

- **Cancellation boundaries.** An already-aborted signal is refused before
  `spawn`: the process adapter and the container adapter return without
  creating a child or invoking Podman.
  Cancelling one slot starts no later slot, releases only claims that provably
  never dispatched, and leaves in-flight evidence accounted for.
- **Pre-dispatch refusals are retriable.** A preparation or planning refusal
  removes only that invocation's provisional root, trial directory or judge
  attempt, so a corrected invocation can retry at the same path. `prepare`
  creates missing parents first, then claims the final directory exclusively,
  so a fresh nested root still works and a competing caller still loses.
- **Staging overlap is refused.** A root inside a fixture (or containing an
  input) fails before anything is created; a pre-existing root is never
  removed.
- **Dry runs preview admission.** `run --dry-run` reports per-slot
  `admissible`/`refused` with a `budget:` or `staging:` reason, accounts for
  spend already claimed and earlier slots in the same preview, and creates no
  claim.
- **Terminal judge publication is one admission-locked state.** Attempt
  evidence, claim closure, the ledger event and the selection land together; a
  concurrent close sees the open claim or the whole terminal state.
- **An early failed attempt cannot mask a later verdict.** A usable judgement
  with a missing or inconsistent selection makes closure refuse with the
  conflict and leave the ledger open. All-terminal failures still close under
  the declared policy.
- **Workspace answer copies are exclusive.** A subject-written answer survives;
  a symlinked or special destination is a capture problem, never followed; the
  canonical answer stays in host-owned evidence.

### CLI

- Flags are defined per command. `close --dry-run`, `status --slot` and other
  unsupported combinations exit 2 before reading state, claiming spend or
  writing evidence.
- `--slot` rejects an explicit empty, blank, duplicate or partly empty
  selector. Omitting it still selects the whole schedule.

### Judge packet transport

The full blinded packet is streamed on stdin instead of the process argument
vector. Packets above the host's 128 KiB single-argument limit are delivered
intact, and no packet content appears in argv. The rehearsal compares the
provider's user-message bytes with the registered packet by SHA-256, not by a
marker, so a truncated or reordered delivery fails the proof.

### Evaluators and packaging

- Packet construction, arm-blindness and verdict classification moved to
  `src/evaluators/docs/{packet,verdict}.ts`; admission, reservation, dispatch
  and terminal publication remain campaign code.
- Common evidence paths live in the dependency-light `src/evidence/paths.ts`.
- The package root exports the supported `checkedAssessments` reader and its
  types, plus the shared judge eligibility types. `readAssessments` remains
  exported and is documented as deprecated; the installed-ESM test imports the
  replacement from the package root.
- Shipped `examples/reporting/rates.mjs` accepts several shard reports and
  reconciles them: every root lists the whole frozen schedule, so an all-unrun
  slot is kept once, a slot executed in exactly one shard takes that row, and
  a slot executed in two shards is refused. Campaign mismatches are refused.

## Migration notes for 0.1.1 users

1. **Assess before judging.** `otc judge` now refuses a slot with no checked
   assessment. Existing roots that were judged without an assessment must run
   `otc assess` first; the historical judged evidence is still read through the
   checked reader.
2. **Remove a judge from skill campaigns.** A campaign with
   `assessment.kind: "skill-activation"` and `assessment.judge` was accepted
   before and refused every slot at judge time. It now fails validation.
3. **Update CLI invocations.** Unsupported flags are no longer ignored; drop
   `--dry-run` from `close` and similar. An empty `--slot` value no longer
   means "whole schedule" — omit the flag.
4. **New roots are inventory version 2.** Old roots replay under their original
   semantics; a mixture inside one root is not supported.
5. **Usage is bound on new trials.** A report from a 0.1.1 root shows
   historical usage as unverified; regenerate the campaign to bind it.

## Consumer guides

The consumer quick start, the no-dispatch/scripted/paid lanes, the eligibility
and evidence-path guidance, and the corrected sharding recipe became available
in the **0.2.0** package. They describe 0.2.0 behaviour: 0.1.1 readers must use
the 0.1.1 README shipped with that version.

## Candidate build evidence (local, before publication)

These facts describe the candidate tarball built from the PR head. They are
**not** registry evidence.

| Fact                | Value                                                               |
| ------------------- | ------------------------------------------------------------------- |
| `npm pack` filename | `markstanden-opencode-test-container-0.2.0.tgz`                     |
| Package version     | `0.2.0`, `engines.node: ">=26"`                                     |
| Shipped assets      | `dist/`, `container/`, `examples/`, `docs/`, `README.md`, `LICENSE` |
| Tarball identity    | recorded in the PR handback and recomputed from the final PR head   |

A hash cannot be written here: this file ships inside the tarball, so adding
the hash would change the artefact it describes.

Local gates on the candidate head: `npm ci`, `npm test` (820 tests),
`npm run typecheck`, `npm run test:coverage`, `defined comply` (compliant, no
repairs on a clean clone), installed-tarball rehearsal, real rootless Podman
smoke (13/13 cases, 34 scripted requests, image `sha256:e7dfd7dd57a6…`),
fresh-docs rehearsal with a >128 KiB blind packet whose provider message
matches the registered packet hash, the installed-package sharding recipe
(two roots, 9 merged rows, 3/3 per case, duplicate execution refused), and the
skills/docs offline rehearsal.

The exact head, PR and CI links are recorded in the PR handback. Nothing here
asserts a published artefact.

## After publication

Only then may this file gain: the merged head, merge SHA, registry `gitHead`,
tarball SHA-256 and npm integrity, attestation and transparency-log links, and
the workflow run id. Publication is triggered by a human tag; this candidate
does not create one.
