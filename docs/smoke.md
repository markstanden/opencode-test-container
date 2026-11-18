# Real-container smoke suite

`npm run test:smoke` is a separate, mandatory integration gate. It packs the
package, installs the tarball into a minimal consumer whose path contains a
space, builds one fresh image from the packaged `container/Containerfile`, and
drives the installed `otc` CLI and shipped adapters against real Podman
containers. Every model turn comes from a loopback scripted provider; no real
provider credential is read and no paid request is made.

Ordinary `npm test` stays hermetic: no Podman, OpenCode, network or credentials.

## Requirements

- Node 26 and npm.
- Rootless Podman 5+.
- Registry access for the Node base image and the pinned OpenCode CLI during
  the image build.
- No sibling docs-plugin checkout. No pre-existing OTC image is required.

A missing runtime is a job failure, not a skip. Set `OTC_SMOKE_RETAIN=1` to
keep the temporary tree and `receipt.json`; set `OTC_SMOKE_NODE_BASE` to pin a
different Node base, or `OTC_SMOKE_IMAGE` to reuse an already-built image while
iterating locally.

## Cases

| ID  | Scenario                           | Boundary proved                                                                                                                                                                 |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | Packaged build, arbitrary consumer | Installed CLI/help/version; fresh image from the packaged recipe; freeze identity                                                                                               |
| S02 | Skill, instruction and plugin      | Real instruction reaches the provider; real plugin tool dispatch with options                                                                                                   |
| S03 | Ordinary lifecycle                 | prepare → freeze → run → assess → idempotent assess → close → status → report                                                                                                   |
| S04 | Trial filesystem policy            | Workspace/tmp writable; subjects/config/root denied; uid, caps, no-new-privileges                                                                                               |
| S05 | Host filesystem isolation          | Absolute host path denied; control mount readable; escaping link refused on host                                                                                                |
| S06 | Primary-checker isolation          | Live/pristine/checker read-only; no provider credentials; no host network                                                                                                       |
| S07 | Judge sandbox policy               | Packet readable, work writable, config/packet read-only, no subjects/evidence                                                                                                   |
| S08 | Explicit network-none boundary     | `network: none` cannot reach a live host listener; host-network control can                                                                                                     |
| S09 | Capture and provider failures      | Truncated and provider-error streams never become passing evidence                                                                                                              |
| S10 | Timeout cleanup                    | Owned timed-out container removed within the grace period; control survives                                                                                                     |
| S11 | Successive-attempt isolation       | A later attempt inherits no workspace canary or ambient session state                                                                                                           |
| S12 | Tampering and report destinations  | Tampered assessment blocks status/close/report; protected destinations refused                                                                                                  |
| S13 | Shipped examples end to end        | Installed examples provider drives three identical positive slots (independent conversations), both negatives, the suite-relative fixture and a second campaign through the CLI |

The suite prints one `PASS`/`FAIL` line per case and a JSON receipt (source
SHA, working-tree state, tarball SHA-256, versions, image ID, case details and
the scripted inference count). `receipt.scriptedInferenceRequests` counts model
requests, not readiness probes.

## What it does not prove

- A scripted provider proves wiring and evidence handling, not natural model
  quality.
- Host networking is not provider-only isolation. Only S08 exercises the
  explicit `network: none` boundary.
- S04–S08 use shipped adapter-level plans and probes, not the full CLI. S01–
  S03 and S09–S13 use the installed CLI.
- A cold build and a cached-layer run take different wall-clock time. The
  recipe does not claim byte-reproducible rebuilds; it records the resolved
  image ID instead.

## CI

`.github/workflows/smoke.yml` is a separate job from the managed `defined`
gate. It runs on pull requests and pushes with a finite timeout. Branch
protection is external administration: creating the workflow does not make it
a required check.
