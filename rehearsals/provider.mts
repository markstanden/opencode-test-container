/**
 * A loopback OpenAI-compatible provider with a scripted response plan.
 *
 * Rehearsal-only: it is never imported by the packaged runtime or by
 * `npm test`. Counting is deliberate: chat-completion requests are counted
 * separately from readiness/model-list probes, so a report never conflates
 * the two.
 */
import { createServer, type ServerResponse } from "node:http";

/** One scripted assistant turn. */
export type ScriptedResponse =
    | { kind: "text"; content: string }
    | { kind: "tool"; tool: string; args: unknown; id?: string }
    | { kind: "error"; status: number; message?: string }
    | { kind: "truncate"; content: string };

/** A captured provider request. */
export interface CapturedRequest {
    /** The method value. */
    method: string;
    /** The path value. */
    path: string;
    /** The body value. */
    body: Record<string, unknown>;
}

/** The running loopback provider. */
export interface ScriptedProvider {
    /** The port value. */
    port: number;
    /** The requests value. */
    requests: CapturedRequest[];
    /** Handles chatCount. */
    chatCount(): number;
    /** Handles otherCount. */
    otherCount(): number;
    /** Handles close. */
    close(): Promise<void>;
}

/** Read one request body as JSON, never throwing. */
async function bodyOf(
    request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** Write one JSON response. */
function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

/** The tool-call delta for one scripted call. */
function toolDelta(tool: string, args: unknown, id: string) {
    return {
        index: 0,
        id,
        type: "function" as const,
        function: { name: tool, arguments: JSON.stringify(args) },
    };
}

/** Stream one completion as OpenAI SSE chunks. */
function stream(
    response: ServerResponse,
    model: unknown,
    chunks: Array<Record<string, unknown>>,
): void {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    let index = 0;
    for (const delta of chunks) {
        const chunk = {
            id: `chatcmpl-otc-${index}`,
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
        };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        index += 1;
    }
    response.write(
        `data: ${JSON.stringify({
            id: "chatcmpl-otc-final",
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
}

/** Serve one scripted response. */
function serve(
    response: ServerResponse,
    body: Record<string, unknown>,
    scripted: ScriptedResponse | undefined,
): void {
    if (scripted === undefined) {
        json(response, 500, {
            error: { message: "script exhausted", type: "server_error" },
        });
        return;
    }
    if (scripted.kind === "error") {
        json(response, scripted.status, {
            error: {
                message: scripted.message ?? "scripted error",
                type: "server_error",
            },
        });
        return;
    }
    if (scripted.kind === "truncate") {
        response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
        });
        response.write(
            `data: ${JSON.stringify({
                id: "chatcmpl-otc-cut",
                object: "chat.completion.chunk",
                created: 1,
                model: body.model,
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: scripted.content },
                        finish_reason: null,
                    },
                ],
            })}\n\n`,
        );
        response.destroy();
        return;
    }
    const streaming = body.stream === true || body.stream_options !== undefined;
    if (scripted.kind === "text") {
        if (!streaming) {
            json(response, 200, {
                id: "chatcmpl-otc",
                object: "chat.completion",
                created: 1,
                model: body.model,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: scripted.content,
                        },
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 1,
                    completion_tokens: 1,
                    total_tokens: 2,
                },
            });
            return;
        }
        stream(response, body.model, [
            { role: "assistant", content: scripted.content },
        ]);
        return;
    }
    const call = toolDelta(
        scripted.tool,
        scripted.args,
        scripted.id ?? "call_otc_1",
    );
    if (!streaming) {
        json(response, 200, {
            id: "chatcmpl-otc-tool",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [
                {
                    index: 0,
                    message: {
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
                    finish_reason: "tool_calls",
                },
            ],
        });
        return;
    }
    stream(response, body.model, [
        { role: "assistant", content: null, tool_calls: [call] },
    ]);
}

/**
 * Start a provider on an exact port with a scripted plan.
 * @param port The loopback port.
 * @param plan One response per chat-completion request, in order.
 * @returns The provider handle.
 */
export async function startProvider(
    port: number,
    plan: readonly ScriptedResponse[],
): Promise<ScriptedProvider> {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
        void bodyOf(request).then((body) => {
            requests.push({
                method: request.method ?? "GET",
                path: request.url ?? "",
                body,
            });
            if (!(request.url ?? "").includes("chat/completions")) {
                json(response, 200, { object: "list", data: [] });
                return;
            }
            const count = requests.filter((entry) =>
                entry.path.includes("chat/completions"),
            ).length;
            serve(response, body, plan[Math.min(count - 1, plan.length - 1)]);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
    return {
        port,
        requests,
        chatCount: () =>
            requests.filter((entry) => entry.path.includes("chat/completions"))
                .length,
        otherCount: () =>
            requests.filter((entry) => !entry.path.includes("chat/completions"))
                .length,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** The provider overlay redirecting a model route to the loopback port. */
export function overlayFor(
    providerId: string,
    port: number,
): Record<string, unknown> {
    return {
        providers: {
            [providerId]: {
                settings: { baseURL: `http://127.0.0.1:${port}/v1` },
            },
        },
    };
}
