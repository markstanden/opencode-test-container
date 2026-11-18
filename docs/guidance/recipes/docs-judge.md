# Docs judge

An optional, separately budgeted model judgement of documentation outcome and
utility, dispatched after a docs trial from an arm-blind packet. The
deterministic criterion remains the criterion; the judge adds a stated semantic
view beside it.

## Declare it

```json
{
    "budgets": { "trials": 2, "judgeAttempts": 2 },
    "assessment": {
        "kind": "docs-recording",
        "judge": {
            "model": "opencode-go/deepseek-v4.1-flash",
            "timeoutMs": 120000
        }
    }
}
```

`judgeAttempts` counts judge **dispatches**, not HTTP requests; a request count
is only reported when the adapter exposes one. Set it to the number of slots you
are willing to judge, plus recoveries if declared. A judge attempt is durable:
a crash keeps the claim rather than refunding it.

## What the judge sees

The judge runs in a neutral container with the packet read-only, a neutral
config home, and no arm subjects, campaign manifest or evidence root. The
packet is arm-blind: it carries the case prompt, the docs outcome and the
`truth` you declared, never an arm identity.

```json
{
    "caseId": "useful-write",
    "kind": "docs-task",
    "truth": "The repository convention is to name spans after the operation.",
    "expectedDocs": { "kind": "create", "target": "notes/otel.md" }
}
```

`truth` is judge context and is never written into a trial workspace. Use it for
facts the judge cannot derive from the diff, not for the verdict you want.

## Optional recovery

Without a declaration there is no retry. To recover one complete JSON-syntax
failure from identical packet bytes:

```json
{
    "recovery": {
        "version": 1,
        "eligibleFailureClasses": ["json-syntax"],
        "requiresCompletionEvidence": true,
        "maxRecoveriesPerSlot": 1,
        "recoveryCeiling": 2,
        "totalJudgeAttempts": 4,
        "providerRequestLimit": null
    }
}
```

Only a complete `json-syntax` failure is recoverable, and only once per slot.
Schema, semantic, empty/truncated and transport failures are terminal for that
attempt. `providerRequestLimit` stays `null` unless the adapter exposes a real
request count. The registration is validated as a whole; do not add fields in
the hope they are ignored.

## Run

```sh
otc prepare  --campaign campaign.json --root /tmp/otc-judge
otc freeze   --root /tmp/otc-judge
otc run      --root /tmp/otc-judge
otc assess   --root /tmp/otc-judge
otc judge    --root /tmp/otc-judge      # after deterministic assessment
otc status   --root /tmp/otc-judge --json
otc close    --root /tmp/otc-judge
otc analyse  --root /tmp/otc-judge --out /tmp/otc-judge-report
```

`judge` selects only checked, deterministic assessments. A pending or unsettled
judgement blocks closure; `status` reports the counts and next action. A judge
failure is recorded with its failure class rather than silently becoming a
pass.

## Expected evidence

- `evidence/judge/<slot>/attempt-*/` — the packet, attempt metadata and verdict.
- A **selection record** per slot naming the chosen attempt, the arm-blind
  packet identity and every attempt fact; a readable file alone is never a
  judgement.
- Report rows carrying `documentationOutcome`, `utility` and the selected
  attempt id.
- Durable recovery claims that are settled by the dispatch outcome.

Tamper with an assessment, packet or metadata and the judge/status/closure path
should refuse: the packet bytes are re-hashed and reconstructed from current
evidence, and a mismatch is an integrity diagnostic, not a re-run trigger.

## What it does not prove

- That the judge is right. It is one model's semantic judgement from a packet,
  and model judgement is not reproducibility.
- That a deterministic failure should be forgiven. The judge does not override
  the deterministic criterion.
- Anything about arms. The judge is deliberately blind to them; attribution
  comes from the slot schedule.

Back to the index: [`README.md`](README.md).
