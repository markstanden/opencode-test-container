/** One scripted reply, in the plan's JSON shape. */
export interface ScriptedReply {
    /** Tool name to call, when the reply is a tool turn. */
    tool?: string;
    /** Tool arguments, serialised by the server. */
    args?: Record<string, unknown>;
    /** Tool-call id, echoed to the client. */
    id?: string;
    /** Assistant text, for a text turn. */
    text?: string;
    /** HTTP status for a scripted provider error. */
    error?: number | string;
    /** Partial content to send before cutting the stream. */
    truncate?: string;
}

/** One plan entry: a prompt substring and its ordered responses. */
export interface ScriptedEntry {
    /** Substring of the latest user message. */
    match: string;
    /** Responses in conversation order. */
    responses?: ScriptedReply[];
}

/** A scripted provider plan. */
export interface ScriptedPlan {
    /** Matched entries, tried in order. */
    entries?: ScriptedEntry[];
    /** Reply used when nothing matches. */
    fallback?: ScriptedReply;
}

/** One message's text, from a chat-completions message object. */
export function userText(messages: readonly unknown[] | undefined): string;

/**
 * Pick the response for one request from the plan and the request's own
 * history.
 */
export function selectResponse(
    plan: ScriptedPlan,
    messages: readonly unknown[] | undefined,
): ScriptedReply;
