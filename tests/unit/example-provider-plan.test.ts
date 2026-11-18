import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectResponse, userText } from "../../examples/provider/plan.mjs";

const PROMPT = "Instrument the checkout service with OpenTelemetry spans.";
const OTHER = "Rename the local variable total to subtotal.";

/** A plan in the shipped shape, with a two-turn and a one-turn entry. */
const plan = {
    entries: [
        {
            match: "Instrument the checkout service",
            responses: [
                {
                    tool: "skill",
                    args: { id: "otel-helper" },
                    id: "call_otel_helper",
                },
                { text: "Instrumented the checkout service." },
            ],
        },
        {
            match: "Rename the local variable",
            responses: [{ text: "Renamed `total` to `subtotal`." }],
        },
    ],
    fallback: { text: "No scripted response matched this prompt." },
};

/** A fresh request whose only user turn is the prompt. */
function start(text: string): unknown[] {
    return [
        { role: "system", content: "system" },
        { role: "user", content: text },
    ];
}

/** A request that already carries the assistant tool call and its result. */
function followUp(text: string): unknown[] {
    return [
        { role: "system", content: "system" },
        { role: "user", content: text },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_otel_helper",
                    type: "function",
                    function: {
                        name: "skill",
                        arguments: '{"id":"otel-helper"}',
                    },
                },
            ],
        },
        {
            role: "tool",
            tool_call_id: "call_otel_helper",
            content: "body",
        },
    ];
}

describe("scripted response selection", () => {
    it("starts every fresh identical conversation with the tool call", () => {
        const first = selectResponse(plan, start(PROMPT));
        const second = selectResponse(plan, start(PROMPT));

        assert.equal(first.tool, "skill");
        assert.equal(second.tool, "skill");
    });

    it("continues one conversation to its final text after the tool result", () => {
        const reply = selectResponse(plan, followUp(PROMPT));

        assert.equal(reply.tool, undefined);
        assert.equal(reply.text, "Instrumented the checkout service.");
    });

    it("keeps interleaved conversations independent", () => {
        const a = selectResponse(plan, start(PROMPT));
        const b = selectResponse(plan, start(PROMPT));
        const aFollow = selectResponse(plan, followUp(PROMPT));
        const bFollow = selectResponse(plan, followUp(PROMPT));

        assert.equal(a.tool, "skill");
        assert.equal(b.tool, "skill");
        assert.equal(aFollow.text, "Instrumented the checkout service.");
        assert.equal(bFollow.text, "Instrumented the checkout service.");
    });

    it("replays an identical retried request without advancing", () => {
        const body = followUp(PROMPT);
        const first = selectResponse(plan, body);
        const retry = selectResponse(plan, body);

        assert.deepEqual(retry, first);
        assert.equal(retry.text, "Instrumented the checkout service.");
    });

    it("restarts at the first response for a new matching user turn", () => {
        const continued = [
            ...followUp(PROMPT),
            {
                role: "assistant",
                content: "Instrumented the checkout service.",
            },
            { role: "user", content: PROMPT },
        ];
        const reply = selectResponse(plan, continued);

        assert.equal(reply.tool, "skill");
    });

    it("serves a text-only plan without inventing a tool turn", () => {
        const reply = selectResponse(plan, start(OTHER));

        assert.equal(reply.tool, undefined);
        assert.equal(reply.text, "Renamed `total` to `subtotal`.");
    });

    it("falls back when nothing matches, including for follow-ups", () => {
        const fresh = selectResponse(plan, start("Something else entirely."));
        const follow = selectResponse(plan, [
            ...start("Something else entirely."),
            { role: "assistant", content: "An answer." },
        ]);

        assert.equal(fresh.text, "No scripted response matched this prompt.");
        assert.equal(follow.text, "No scripted response matched this prompt.");
    });

    it("reads content-array user messages", () => {
        const body = [
            {
                role: "user",
                content: [{ type: "text", text: PROMPT }],
            },
        ];

        assert.equal(userText(body), PROMPT);
        assert.equal(selectResponse(plan, body).tool, "skill");
    });

    it("advances through a multi-response plan by assistant turns", () => {
        const multi = {
            entries: [
                {
                    match: "three steps",
                    responses: [
                        { tool: "skill", args: { id: "a" }, id: "c1" },
                        { tool: "skill", args: { id: "b" }, id: "c2" },
                        { text: "Done." },
                    ],
                },
            ],
        };
        const first = selectResponse(multi, start("three steps"));
        const second = selectResponse(multi, [
            ...start("three steps"),
            { role: "assistant", content: null, tool_calls: [] },
        ]);
        const third = selectResponse(multi, [
            ...start("three steps"),
            { role: "assistant", content: null, tool_calls: [] },
            { role: "tool", tool_call_id: "c1", content: "a" },
            { role: "assistant", content: null, tool_calls: [] },
            { role: "tool", tool_call_id: "c2", content: "b" },
        ]);

        assert.equal(first.tool, "skill");
        assert.equal(second.tool, "skill");
        assert.equal(third.text, "Done.");
    });

    it("clamps to the last response rather than failing past the plan", () => {
        const body = [
            ...start(PROMPT),
            { role: "assistant", content: null, tool_calls: [] },
            { role: "assistant", content: "already answered" },
            { role: "assistant", content: "and again" },
        ];

        assert.equal(
            selectResponse(plan, body).text,
            "Instrumented the checkout service.",
        );
    });
});
