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
  wins.
- The provider keeps no per-prompt counter. Which response a request gets is
  derived from that request's own history: the number of `assistant` messages
  after its latest `user` message. A fresh conversation (no assistant turn yet)
  gets `responses[0]`; the follow-up after a tool result gets `responses[1]`;
  an identical prompt later in the conversation starts at `responses[0]` again.
- Consequences: identical fresh conversations always start the same way,
  interleaved clients never consume each other's plan, and a retried identical
  request replays the same response instead of advancing. Requests past the end
  of a plan repeat its last response.
- A response is `{ "text": "…" }`, `{ "tool": "name", "args": { … } }`,
  `{ "error": 500 }` or `{ "truncate": "partial text" }`. The last two let a
  recipe demonstrate an operational failure without a real provider.
- Streamed tool turns finish with `tool_calls`; streamed text finishes with
  `stop`.
- `GET /health` answers readiness without consuming a chat response. Its
  `chatRequests` counter is server-wide and counts every chat-completions
  request actually received, including retries and scripted errors.

This is a fixture, not a simulator: it exercises OTC's wiring and scoring, not
model behaviour. A response plan that loads a skill proves the harness records
a load, not that a real model would choose the skill.
