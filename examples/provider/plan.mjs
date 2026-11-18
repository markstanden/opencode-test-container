/**
 * Response selection for the scripted provider.
 *
 * The provider is stateless: where a conversation is in its plan is derived
 * from that request's own message history, so fresh conversations and
 * interleaved clients never consume each other's responses. Kept separate from
 * `server.mjs` so the rule can be unit-tested without opening a socket.
 */

/** One message's text, from a chat-completions message object. */
function textOf(message) {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (part) => part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
}

/** The latest user message's text, from a chat-completions message list. */
export function userText(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        if (message?.role !== "user") continue;
        return textOf(message);
    }
    return "";
}

/** Index of the user turn this request is answering, or -1. */
function currentUserIndex(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index]?.role === "user") return index;
    }
    return -1;
}

/**
 * How many assistant turns this request carries after its current user turn.
 * A fresh request is 0; the follow-up carrying a tool result is 1.
 */
function turnPosition(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const start = currentUserIndex(list);
    if (start === -1) return 0;
    let assistants = 0;
    for (let index = start + 1; index < list.length; index += 1) {
        if (list[index]?.role === "assistant") assistants += 1;
    }
    return assistants;
}

/**
 * Pick the response for one request from the plan and the request's own
 * history. Unknown prompts get the plan fallback; a request past the end of a
 * plan replays its last response rather than failing.
 */
export function selectResponse(plan, messages) {
    const text = userText(messages);
    const fallback = plan?.fallback ?? {
        text: "No scripted response matched.",
    };
    const entry = (plan?.entries ?? []).find((candidate) =>
        text.includes(candidate.match),
    );
    if (entry === undefined) return fallback;
    const responses = entry.responses ?? [];
    if (responses.length === 0) return fallback;
    const position = Math.min(turnPosition(messages), responses.length - 1);
    return responses[position] ?? fallback;
}
