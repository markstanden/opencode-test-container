# Scripted skill activation

The cheapest complete run: real Podman containers and the real OpenCode CLI,
with a loopback scripted provider. No credential is read and no paid request is
made. Use it to prove the harness works before trusting any real-provider
result.

Configuration: [`examples/skills`](../../../examples/skills) plus the provider
fixture at [`examples/provider`](../../../examples/provider). Both ship in the
package. From a checkout, run from `examples/skills/`; from an installed
consumer, the same directory is under
`node_modules/@markstanden/opencode-test-container/examples/skills` (or
`$(npm root -g)/…` for a global install).

## Prerequisites

- Rootless Podman 5+.
- Node 26 to run the provider fixture.
- An image carrying OpenCode 2.2.6. Build it with the arguments in
  [`container/README.md`](../../../container/README.md), or replace
  `runtime.image` with an image you already trust. `freeze` records the resolved
  image id either way.

## Run

```sh
export ZAI_API_KEY=not-a-real-key
node ../provider/server.mjs --port 8799 --plan provider-plan.json &
curl --fail http://127.0.0.1:8799/health

otc validate --campaign campaign.json
otc prepare  --campaign campaign.json --root /tmp/otc-scripted
otc freeze   --root /tmp/otc-scripted
otc run      --root /tmp/otc-scripted
otc assess   --root /tmp/otc-scripted
otc close    --root /tmp/otc-scripted
otc analyse  --root /tmp/otc-scripted --out /tmp/otc-scripted-report
```

The overlay rewrites the declared provider's base URL to
`http://127.0.0.1:8799/v1`; `ZAI_API_KEY` is a fixture placeholder whose value
never reaches a real service. `network: "host"` is what lets the container reach
the loopback listener.

## Expected evidence

`assess` reports three passes:

| Slot | Case                | Observed            | Outcome |
| ---- | ------------------- | ------------------- | ------- |
| `s1` | positive-instrument | `target-activation` | pass    |
| `s2` | negative-unrelated  | `no-invocation`     | pass    |
| `s3` | negative-near-miss  | `no-invocation`     | pass    |

Per trial, `evidence/trials/<slotId>/` holds `workspace/`, `config-home/`,
`events.jsonl` and `meta.json`; `evidence/assessments/<slotId>.json` holds the
deterministic assessment. The report's slot table should agree with the above.

## What it proves

- The suite, campaign, staging, config-home skill catalogue, episode capture,
  event decoding and deterministic assessment agree end to end.
- A failed target load is `unknown`, and an unreadable capture is `invalid`,
  neither of which becomes a passing negative.

## What it does not prove

- Anything about how a real model chooses skills. The plan answers from a
  substring match; that is the point of a fixture.
- That the skill's work is correct. Activation is the only criterion.
- That the image you supplied contains the OpenCode version you think; read
  `freeze`'s recorded identity.

## Common failures

| Symptom                         | Cause                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| `prepare` refuses the root      | the directory already exists; use a fresh `--root`         |
| every trial invalid             | provider not listening on 8799, or `network` is not `host` |
| `s1` observed `no-invocation`   | plan entry `match` does not occur in the prompt            |
| assess reports `unknown`        | failed target load or an unusable capture, never a pass    |
| image resolve fails at `freeze` | image tag wrong, or Podman cannot pull/build it            |

Next: put the same suite behind a real route —
[`trigger-rate-with-repetitions.md`](trigger-rate-with-repetitions.md).
