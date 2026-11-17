# Offline real-adapter rehearsals

The standalone, no-sibling-checkout gate is `npm run test:smoke`
([`smoke.md`](smoke.md)). The product rehearsals below remain optional
integration evidence.

## Baseline (`npm run rehearse:offline`)

Recorded 2026-11-15 from `npm run rehearse:offline` on the dev box.

- Image: `localhost/opencode-placement-trials:latest`
- Image ID: `sha256:58505eac2fe9161a02db4719e6a8a34e9106b644e9eee0aaa00184269b643beb`
- OpenCode: `v2.2.6` (the tested CLI; not upgraded by this work)
- Provider: scripted loopback OpenAI-compatible server
- Paid provider calls: **0**
- Scripted chat requests: **22**
- Readiness/model-list probes: **0**

| Suite  | Slot            | Validity | Observed           | Outcome | Chat requests |
| ------ | --------------- | -------- | ------------------ | ------- | ------------- |
| skills | positive        | valid    | target-activation  | pass    | 2             |
| skills | negative        | valid    | no-invocation      | pass    | 1             |
| skills | wrong-skill     | valid    | other-skill-only   | pass    | 2             |
| skills | failed-load     | unknown  | failed-target-load | unknown | 2             |
| skills | invalid-capture | invalid  | unrun              | unknown | 11            |
| docs   | useful-write    | valid    | —                  | pass    | 2             |
| docs   | gate-blocked    | valid    | —                  | pass    | 2             |

Docs counts: useful write credited 1 call / 1 write; gate-blocked credited 1
call / **0 writes**, attempted 1. Both journals verified with the per-run key.
The truncated capture retried at the adapter level (11 HTTP requests) and is
recorded as invalid, not as a passing negative. A failed target load is
`unknown`, not a negative.

Isolation checks: no suite, campaign, manifest or freeze file appeared in a
trial workspace or config home; no hidden criteria string appeared in either;
every slot made at least one provider request.

This proves the machinery and the evidence boundary offline. It is **not**
evidence of real model quality.

## Fresh docs lifecycle (`npm run rehearse:fresh-docs`)

Same image and scripted provider, plus the product primary check, blind judge
and recovery path:

| Slot            | Primary | Outcome | Selected attempt | Trial chat | Judge chat |
| --------------- | ------- | ------- | ---------------- | ---------- | ---------- |
| useful-write    | pass    | pass    | attempt-001      | 2          | 1          |
| gate-blocked    | pass    | pass    | attempt-001      | 2          | 1          |
| primary-failure | fail    | fail    | attempt-001      | 1          | 1          |
| recovery        | —       | pass    | attempt-002      | 1          | 2          |

The recovery's first judge attempt returned prose, the second a valid
`none` verdict; both recorded the same `packetSha256`. The separate
exhausted-budget root refused recovery after one judge claim, made one chat
request and wrote no selection. The gate-blocked write kept zero credited
writes. The checker never appeared in the trial workspace or config home.
Post-close `run` and `judge` both exited 1; analysis after closure recorded all
four judgements.

Totals: 6 trial + 5 judge + 1 exhausted scripted chat requests, 0 readiness
probes, 0 paid provider calls.

## Installed tarball (`npm run rehearse:installed`)

The checkout is packed, installed into a consumer directory whose path
contains a space, and the same fresh docs lifecycle runs through
`node_modules/.bin/otc`. The 2026-11-15 run used image
`sha256:58505eac…`, OpenCode 2.2.6 and installed version `0.1.0`; it produced
the same four-slot result, one recovery, one exhausted refusal and zero paid
calls. The receipt records the tarball filename, SHA-256 and npm integrity;
the exact identity is reported with the handback attestation.
The development-only provider stays outside the tarball.

The migrated `harness/run.ts` CLI is gone: it could spawn the docs
repository's old `placement-harness/harness.mts`. The generic evidence guard
lives at `src/campaign/evidence-guard.ts`; OTC now accepts only product data
(suite, truth, checker bytes), never a sibling engine.
