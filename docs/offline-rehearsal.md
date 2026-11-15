# Offline real-adapter rehearsal

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
