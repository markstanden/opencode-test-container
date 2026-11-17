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
    | { kind: "truncate"; content: string }
    | { kind: "stall" };

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

/** Hold a response open so a live dispatch can be cancelled. */
function stall(response: ServerResponse, body: Record<string, unknown>): void {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
    });
    response.write(
        `data: ${JSON.stringify({ id: "chatcmpl-otc-stall", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    );
}

/** Send one partial stream, then cut the connection. */
function truncate(
    response: ServerResponse,
    body: Record<string, unknown>,
    content: string,
): void {
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
                    delta: { role: "assistant", content },
                    finish_reason: null,
                },
            ],
        })}\n\n`,
    );
    response.destroy();
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
    if (scripted.kind === "stall") return stall(response, body);
    if (scripted.kind === "error") {
        return json(response, scripted.status, {
            error: {
                message: scripted.message ?? "scripted error",
                type: "server_error",
            },
        });
    }
    if (scripted.kind === "truncate") {
        return truncate(response, body, scripted.content);
    }
    if (scripted.kind === "text") {
        return serveText(response, body, scripted.content);
    }
    return serveTool(response, body, scripted);
}

/** Serve one complete text completion, streaming when asked. */
function serveText(
    response: ServerResponse,
    body: Record<string, unknown>,
    content: string,
): void {
    const streaming = body.stream === true || body.stream_options !== undefined;
    if (streaming) {
        stream(response, body.model, [{ role: "assistant", content }]);
        return;
    }
    json(response, 200, {
        id: "chatcmpl-otc",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
        },
    });
}

/** Serve one tool-call completion, streaming when asked. */
function serveTool(
    response: ServerResponse,
    body: Record<string, unknown>,
    scripted: { tool: string; args: unknown; id?: string },
): void {
    const streaming = body.stream === true || body.stream_options !== undefined;
    const call = toolDelta(
        scripted.tool,
        scripted.args,
        scripted.id ?? "call_otc_1",
    );
    if (streaming) {
        stream(response, body.model, [
            {
                role: "assistant",
                content: null,
                tool_calls: [call],
            },
        ]);
        return;
    }
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
    options: { repeatLast?: boolean } = {},
): Promise<ScriptedProvider & { exhausted: () => number }> {
    const requests: CapturedRequest[] = [];
    const repeatLast = options.repeatLast ?? true;
    let exhausted = 0;
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
            if (!repeatLast && count > plan.length) {
                exhausted += 1;
                json(response, 500, {
                    error: {
                        message: "script exhausted",
                        type: "server_error",
                    },
                });
                return;
            }
            serve(response, body, plan[Math.min(count - 1, plan.length - 1)]);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const bound =
        typeof address === "object" && address !== null ? address.port : port;
    return {
        port: bound,
        requests,
        exhausted: () => exhausted,
        chatCount: () =>
            requests.filter((entry) => entry.path.includes("chat/completions"))
                .length,
        otherCount: () =>
            requests.filter((entry) => !entry.path.includes("chat/completions"))
                .length,
        close: () =>
            new Promise<void>((resolve) => {
                let settled = false;
                const finish = (): void => {
                    if (settled) return;
                    settled = true;
                    resolve();
                };
                const timer = setTimeout(finish, 2_000);
                server.close(() => {
                    clearTimeout(timer);
                    finish();
                });
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
