#!/usr/bin/env node
/**
 * Scripted loopback provider for OTC examples.
 *
 * Speaks enough of the OpenAI chat-completions API for OpenCode to complete a
 * trial, with no credentials and no traffic beyond 127.0.0.1. It is a fixture,
 * not a model: responses come from a JSON plan keyed by the latest user
 * message, so one provider can serve every slot in a small campaign.
 *
 * Usage: node server.mjs [--port 8799] [--plan provider-plan.json]
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectResponse } from "./plan.mjs";

const args = process.argv.slice(2);

/** Read one flag's value, or a fallback. */
function valueAfter(name, fallback) {
    const index = args.indexOf(name);
    return index === -1 ? fallback : args[index + 1];
}

const port = Number(valueAfter("--port", "8799"));
const planPath = resolve(valueAfter("--plan", "provider-plan.json"));
const plan = JSON.parse(readFileSync(planPath, "utf8"));

let chatRequests = 0;

/** Read one request body as JSON, never throwing. */
async function bodyOf(request) {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

/** Write one JSON response. */
function sendJson(response, status, value) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

/** One streaming chunk. */
function chunk(body, delta, finishReason = null) {
    return `data: ${JSON.stringify({
        id: "chatcmpl-otc-scripted",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
}

/** Stream a complete assistant turn and close the response. */
function streamText(response, body, delta, finishReason = "stop") {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    response.write(chunk(body, { role: "assistant", ...delta }));
    response.write(chunk(body, {}, finishReason));
    response.end("data: [DONE]\n\n");
}

/** A complete non-streaming completion. */
function complete(response, body, message, finishReason) {
    sendJson(response, 200, {
        id: "chatcmpl-otc-scripted",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

/** Serve one planned tool call. */
function toolCall(response, body, reply, streaming) {
    const call = {
        index: 0,
        id: reply.id ?? "call_scripted_1",
        type: "function",
        function: {
            name: reply.tool,
            arguments: JSON.stringify(reply.args ?? {}),
        },
    };
    if (streaming) {
        return streamText(
            response,
            body,
            {
                content: null,
                tool_calls: [call],
            },
            "tool_calls",
        );
    }
    return complete(
        response,
        body,
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: call.id,
                    type: "function",
                    function: call.function,
                },
            ],
        },
        "tool_calls",
    );
}

/** Serve one planned text turn. */
function textTurn(response, body, reply, streaming) {
    const content = reply.text ?? "";
    if (streaming) return streamText(response, body, { content });
    return complete(response, body, { role: "assistant", content }, "stop");
}

/** Send one partial stream, then cut the connection. */
function truncate(response, body, content) {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
    });
    response.write(
        chunk(body, { role: "assistant", content: String(content ?? "") }),
    );
    response.destroy();
}

const server = createServer((request, response) => {
    void bodyOf(request).then((body) => {
        const path = request.url ?? "";
        if (path === "/health") {
            return sendJson(response, 200, { ok: true, chatRequests });
        }
        if (!path.includes("chat/completions")) {
            return sendJson(response, 200, { object: "list", data: [] });
        }
        chatRequests += 1;
        const reply = selectResponse(plan, body.messages);
        if (reply.error !== undefined) {
            const status = Number(reply.error) || 500;
            return sendJson(response, status, {
                error: {
                    message: "scripted provider error",
                    type: "server_error",
                },
            });
        }
        if (reply.truncate !== undefined) {
            return truncate(response, body, reply.truncate);
        }
        const streaming =
            body.stream === true || body.stream_options !== undefined;
        if (reply.tool !== undefined) {
            return toolCall(response, body, reply, streaming);
        }
        return textTurn(response, body, reply, streaming);
    });
});

server.listen(port, "127.0.0.1", () => {
    console.error(`scripted provider listening on http://127.0.0.1:${port}`);
    console.error(`plan: ${planPath}`);
});
