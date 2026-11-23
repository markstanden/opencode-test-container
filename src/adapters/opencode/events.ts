import { isRecord } from "../../contracts/validate.ts";
import { compareCodeUnits } from "../../contracts/ordering.ts";

/** One deduplicated tool call decoded from the CLI event stream. */
export interface ToolCall {
    /** The id value. */
    id: string;
    /** The tool value. */
    tool: string | null;
    /** The status value. */
    status: string | null;
    /** The input value. */
    input: unknown;
    /** The output value. */
    output: string | null;
    /** The metadata value. */
    metadata: unknown;
}

/** Token and cost usage folded from `step_finish` events. */
export interface Usage {
    /** The input tokens value. */
    inputTokens: number;
    /** The output tokens value. */
    outputTokens: number;
    /** The reasoning tokens value. */
    reasoningTokens: number;
    /** The cache read tokens value. */
    cacheReadTokens: number;
    /** The cache write tokens value. */
    cacheWriteTokens: number;
    /** The cost usd value. */
    costUsd: number;
    /** Whether every usage value came from a recorded step-finish event. */
    reported: boolean;
    /**
     * Field coverage: a missing value is unknown, never a measured zero. An
     * explicit zero supplied by a step-finish event is measured.
     */
    coverage: {
        tokens: "measured" | "partial" | "unknown";
        cost: "measured" | "partial" | "unknown";
    };
    /** The steps value. */
    steps: number;
}

/** A decoded trial event stream. */
export interface DecodedTrail {
    /** Parsed events. */
    events: number;
    /** Non-empty lines that were not JSON objects. */
    parseFailures: number;
    /** The concatenated answer text, newline-terminated. */
    text: string;
    /** Number of text parts observed. */
    textParts: number;
    /** The last part kind observed, or null. */
    lastPartKind: "text" | "tool" | null;
    /** Deduplicated calls in first-seen order. */
    calls: ToolCall[];
    /** Session identities observed. */
    sessions: string[];
    /** Message identities observed. */
    messages: string[];
    /** Known usage, with `reported` false when no step-finish event existed. */
    usage: Usage;
}

/** The empty usage accumulator. */
function emptyUsage(): Usage {
    return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        reported: false,
        coverage: { tokens: "unknown", cost: "unknown" },
        steps: 0,
    };
}

/** Parse one JSONL line, or undefined when it is not an object. */
function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Fold one event's identity ids into the trail. */
function foldIdentity(
    event: Record<string, unknown>,
    sessions: Set<string>,
    messages: Set<string>,
): void {
    if (typeof event.sessionID === "string") sessions.add(event.sessionID);
    if (typeof event.messageID === "string") messages.add(event.messageID);
    if (!isRecord(event.part)) return;
    if (typeof event.part.sessionID === "string") {
        sessions.add(event.part.sessionID);
    }
    if (typeof event.part.messageID === "string") {
        messages.add(event.part.messageID);
    }
}

/** The first defined value, or null. */
function firstDefined(...values: unknown[]): unknown {
    for (const value of values) {
        if (value !== undefined) return value;
    }
    return null;
}

/** Merge one latest-state tool part over its previous call. */
function mergedToolCall(
    previous: ToolCall | undefined,
    part: Record<string, unknown>,
    id: string,
): ToolCall {
    const state: Record<string, unknown> = isRecord(part.state)
        ? part.state
        : {};
    const prev: ToolCall = previous ?? {
        id,
        tool: null,
        status: null,
        input: null,
        output: null,
        metadata: null,
    };
    return {
        id,
        tool: firstDefined(part.tool, prev.tool) as string | null,
        status: firstDefined(state.status, prev.status) as string | null,
        input: firstDefined(state.input, prev.input),
        output: firstDefined(state.output, prev.output) as string | null,
        metadata: firstDefined(state.metadata, prev.metadata),
    };
}

/** Fold one tool part over the previous call state. */
function foldToolPart(
    part: Record<string, unknown>,
    calls: Map<string, ToolCall>,
    unkeyed: { count: number },
): void {
    const id =
        typeof part.id === "string" && part.id !== ""
            ? part.id
            : `unkeyed-${++unkeyed.count}`;
    calls.set(id, mergedToolCall(calls.get(id), part, id));
}

/** Fold one step-finish event's usage into the accumulator. */
/** Fold one token block, keeping missing values distinct from zero. */
function foldTokens(
    usage: Usage,
    tokens: Record<string, unknown>,
    cache: Record<string, unknown>,
): void {
    const token = (field: string): number =>
        typeof tokens[field] === "number" ? (tokens[field] as number) : 0;
    const seen = [
        tokens.input,
        tokens.output,
        tokens.reasoning,
        cache.read,
        cache.write,
    ].filter((value) => typeof value === "number").length;
    usage.inputTokens += token("input");
    usage.outputTokens += token("output");
    usage.reasoningTokens += token("reasoning");
    usage.cacheReadTokens += typeof cache.read === "number" ? cache.read : 0;
    usage.cacheWriteTokens += typeof cache.write === "number" ? cache.write : 0;
    if (seen < 5) {
        usage.coverage.tokens = "partial";
    } else if (usage.coverage.tokens !== "partial") {
        usage.coverage.tokens = "measured";
    }
}

/** Fold one step-finish event's usage and coverage. */
function foldUsage(event: Record<string, unknown>, usage: Usage): void {
    const part = isRecord(event.part) ? event.part : undefined;
    if (part?.type !== "step-finish") return;
    usage.reported = true;
    usage.steps += 1;
    const tokens = isRecord(part.tokens) ? part.tokens : {};
    foldTokens(usage, tokens, isRecord(tokens.cache) ? tokens.cache : {});
    if (typeof part.cost === "number") {
        usage.costUsd += part.cost;
        if (usage.coverage.cost !== "partial") {
            usage.coverage.cost = "measured";
        }
    } else {
        usage.coverage.cost = "partial";
    }
}

/**
 * Decode `opencode run --format json` JSONL into answer, calls, identity and
 * usage. Malformed lines are counted, never treated as an empty trail.
 * @param stdout Raw CLI stdout.
 * @returns The decoded trail.
 */
export function decodeTrail(stdout: string): DecodedTrail {
    const texts: string[] = [];
    const calls = new Map<string, ToolCall>();
    const sessions = new Set<string>();
    const messages = new Set<string>();
    const usage = emptyUsage();
    const unkeyed = { count: 0 };
    let events = 0;
    let parseFailures = 0;
    let textParts = 0;
    let lastPartKind: "text" | "tool" | null = null;
    for (const line of stdout.split("\n").filter((entry) => entry !== "")) {
        const event = parseLine(line);
        if (event === undefined) {
            parseFailures += 1;
            continue;
        }
        events += 1;
        foldIdentity(event, sessions, messages);
        foldUsage(event, usage);
        const part = isRecord(event.part) ? event.part : event;
        if (part.type === "text" && typeof part.text === "string") {
            texts.push(part.text);
            textParts += 1;
            lastPartKind = "text";
            continue;
        }
        if (part.type === "tool") {
            foldToolPart(part, calls, unkeyed);
            lastPartKind = "tool";
        }
    }
    return {
        events,
        parseFailures,
        text: `${texts.join("\n").trim()}\n`,
        textParts,
        lastPartKind,
        calls: [...calls.values()],
        sessions: [...sessions],
        messages: [...messages],
        usage,
    };
}

/** Whether a decoded stream is a complete, readable observation. */
export function captureProblems(trail: DecodedTrail): string[] {
    const problems: string[] = [];
    if (trail.events === 0) problems.push("the trial emitted no events");
    if (trail.parseFailures > 0) {
        problems.push(
            `${trail.parseFailures} event line(s) were not readable JSON`,
        );
    }
    if (trail.textParts === 0) {
        problems.push("the trial emitted no answer text");
    }
    if (trail.lastPartKind !== "text") {
        problems.push("the trial stream did not end on an answer");
    }
    return problems;
}

/** One skill tool call observed in a trail. */
export interface SkillCall {
    /** The call id value. */
    callId: string;
    /** The requested skill identity, when the input names one. */
    requestedId: string | null;
    /** The status value. */
    status: string | null;
    /** Whether the call completed with a non-empty skill body. */
    loaded: boolean;
}

/** Fold the input/output of one skill call into its observation. */
function skillCallOf(call: ToolCall): SkillCall | null {
    if (call.tool !== "skill") return null;
    const input = isRecord(call.input) ? call.input : {};
    let requested: string | null = null;
    if (typeof input.id === "string") requested = input.id;
    else if (typeof input.name === "string") requested = input.name;
    const output = call.output?.trim() ?? "";
    return {
        callId: call.id,
        requestedId: requested,
        status: call.status,
        loaded:
            call.status === "completed" &&
            output !== "" &&
            !output.startsWith("Rejected:"),
    };
}

/**
 * Every skill invocation in a trail, including other skills and failed loads.
 * @param trail The decoded trial.
 * @returns Skill calls in first-seen order.
 */
export function skillCalls(trail: DecodedTrail): SkillCall[] {
    return trail.calls
        .map(skillCallOf)
        .filter((call): call is SkillCall => call !== null);
}

/**
 * Whether a non-skill tool route names the target skill body. Activation
 * through the skill tool is the criterion; a `read`, `grep`, `glob` or
 * `execute` route is contamination evidence, not a successful activation.
 * @param trail The decoded trial.
 * @param targetSkillId The target identity.
 * @returns The tool names that touched the target body, deduplicated.
 */
export function bodyRoutes(
    trail: DecodedTrail,
    targetSkillId: string,
): string[] {
    const routes = new Set<string>();
    const needles = [
        `skills/${targetSkillId}/SKILL.md`,
        `skill://${targetSkillId}`,
    ];
    for (const call of trail.calls) {
        if (call.tool === "skill") continue;
        const text = JSON.stringify(call.input ?? null);
        if (needles.some((needle) => text.includes(needle))) {
            routes.add(call.tool ?? "unknown");
        }
    }
    return [...routes].sort(compareCodeUnits);
}
