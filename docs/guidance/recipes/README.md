# Recipes

Executable configurations, each with the evidence it should produce and the
claim it cannot support. Start with the one that costs nothing.

| Recipe                                                                 | Provider          | Establishes                                                     |
| ---------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| [`scripted-skill-activation.md`](scripted-skill-activation.md)         | scripted loopback | OTC's staging, capture and scoring work end to end              |
| [`trigger-rate-with-repetitions.md`](trigger-rate-with-repetitions.md) | real route        | Activation and criterion pass rates, per case and arm           |
| [`before-after-instructions.md`](before-after-instructions.md)         | real route        | Whether changed always-loaded guidance changes behaviour        |
| [`docs-recording.md`](docs-recording.md)                               | scripted or real  | Whether the docs plugin records or refuses correctly            |
| [`docs-judge.md`](docs-judge.md)                                       | real judge model  | A semantic documentation judgement beside the deterministic one |

Two honesty rules apply to every recipe:

1. A scripted provider proves wiring and scoring, not model behaviour.
2. Validation proves configuration shape, not experiment validity.

Only the first recipe runs from the published package with no extra checkout.
The real-provider recipes need a route and a credential; the docs recipes need a
docs plugin bundle at `plugins[].path`. Backticks show where to substitute.

Commands assume `otc` is on `PATH` and each `--root` is fresh: `prepare` refuses
an existing root rather than merging. Freeze `timeoutMs` above the slowest
trial you have seen — a timeout discards the evidence as invalid.

## Reading a run

Every recipe uses the same lifecycle:

```sh
otc validate --campaign <campaign.json>
otc prepare  --campaign <campaign.json> --root <root>
otc freeze   --root <root>
otc run      --root <root> --dry-run  # needs the freeze above; plans only
otc run      --root <root>
otc assess   --root <root>
otc close    --root <root>
otc analyse  --root <root> --out <fresh-report-dir>
otc status   --root <root> --json
```

`run` dispatches; `assess` does not call a model; `close` refuses unresolved
claims and unassessable trials; `analyse` writes `report.json` and `report.md`
outside the evidence root. Read validity before reading pass counts: `unknown`
and `invalid` are non-evidence, not failures of the description.
