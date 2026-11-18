# Skill-only example

A minimal, self-contained skill bundle and suite. It needs no docs plugin and
no judge: three trials check that a scripted model which loads `otel-helper`
for the instrumenting prompt, and only that prompt, is scored as three passing
cases.

The campaign expects:

- a sandbox image carrying OpenCode 2.2.6 — build one with the arguments in
  [`container/README.md`](../../container/README.md), or replace `runtime.image`
  with an image you already trust;
- the scripted loopback provider from [`examples/provider`](../provider) on
  `127.0.0.1:8799`;
- `ZAI_API_KEY` set to any value. It is a fixture placeholder: the overlay
  rewrites that provider's base URL to the loopback server, so no request
  reaches the real provider and no credential is valid there.

```sh
export ZAI_API_KEY=not-a-real-key
node ../provider/server.mjs --port 8799 --plan provider-plan.json &
curl --fail http://127.0.0.1:8799/health   # readiness

otc validate --campaign campaign.json
otc prepare  --campaign campaign.json --root /tmp/otc-run
otc freeze   --root /tmp/otc-run
otc run      --root /tmp/otc-run
otc assess   --root /tmp/otc-run
otc close    --root /tmp/otc-run
otc analyse  --root /tmp/otc-run --out /tmp/otc-report
```

`assess` should report three passes: `s1` observed `target-activation`, `s2`
and `s3` observed `no-invocation`. Each trial's capture, metadata and workspace
are under `/tmp/otc-run/evidence/trials/<slotId>/`; the deterministic
assessment is `/tmp/otc-run/evidence/assessments/<slotId>.json`.

What this does not prove: a scripted plan stands in for the model, so the run
exercises OTC's wiring and scoring, not real model behaviour. Activation on a
positive prompt is not evidence that the skill completes its task — see
[`docs/guidance/choose-what-youre-measuring.md`](../../docs/guidance/choose-what-youre-measuring.md).
