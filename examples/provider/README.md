# Scripted provider

A loopback, dependency-free OpenAI-compatible provider used by the shipped
examples. It never reads a real credential and never talks to anything but
`127.0.0.1`.

```sh
node examples/provider/server.mjs --port 8799 --plan examples/skills/provider-plan.json
curl --fail http://127.0.0.1:8799/health
```

## Plan format

```jsonc
{
    "entries": [
        {
            "match": "Instrument the checkout service",
            "responses": [
                { "tool": "skill", "args": { "id": "otel-helper" } },
                { "text": "Instrumented the checkout service." },
            ],
        },
    ],
    "fallback": { "text": "No scripted response matched." },
}
```

- `match` is a substring of the latest user message. The first matching entry
  wins; each entry serves its `responses` in order and repeats the last one.
- A response is `{ "text": "…" }`, `{ "tool": "name", "args": { … } }`,
  `{ "error": 500 }` or `{ "truncate": "partial text" }`. The last two let a
  recipe demonstrate an operational failure without a real provider.
- `GET /health` answers readiness without consuming a chat response.

This is a fixture, not a simulator: it exercises OTC's wiring and scoring, not
model behaviour. A response plan that loads a skill proves the harness records
a load, not that a real model would choose the skill.
