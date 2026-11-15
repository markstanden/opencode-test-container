import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../contracts/validate.ts";

/** The finite ledger event names the lifecycle understands. */
export const LEDGER_EVENTS = [
    "trial-start",
    "trial-end",
    "primary-check",
    "assessment",
    "judge-attempt",
    "judge-selection",
    "close",
] as const;

/** One ledger event name. */
export type LedgerEventName = (typeof LEDGER_EVENTS)[number];

/** An append-only lifecycle event. */
export interface LedgerEvent {
    /** The schema version value. */
    schemaVersion: 1;
    /** The event value. */
    event: LedgerEventName;
    /** The at value. */
    at: string;
    /** The campaign id value. */
    campaignId: string;
    [field: string]: unknown;
}

/** The readable ledger state: absence, open, closed or malformed. */
export interface LedgerRead {
    /** The state value. */
    state: "absent" | "open" | "closed" | "malformed";
    /** The events value. */
    events: LedgerEvent[];
    /** The problems value. */
    problems: string[];
    /** The closed at value. */
    closedAt: string | null;
}

/** Path of the append-only attempts ledger. */
export function ledgerPath(root: string): string {
    return join(root, "evidence", "ATTEMPTS.jsonl");
}

/** Whether a value names a known event. */
function isEventName(value: unknown): value is LedgerEventName {
    return (
        typeof value === "string" &&
        (LEDGER_EVENTS as readonly string[]).includes(value)
    );
}

/** Parse one non-blank ledger line into an event, or a problem. */
function parseEventLine(
    line: string,
    index: number,
): { ok: true; event: LedgerEvent } | { ok: false; problem: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return { ok: false, problem: `line ${index + 1} is not JSON` };
    }
    if (!isRecord(parsed)) {
        return { ok: false, problem: `line ${index + 1} is not an object` };
    }
    if (parsed.schemaVersion !== 1) {
        return {
            ok: false,
            problem: `line ${index + 1} has an unsupported schemaVersion`,
        };
    }
    if (!isEventName(parsed.event)) {
        return { ok: false, problem: `line ${index + 1} has an unknown event` };
    }
    if (
        typeof parsed.at !== "string" ||
        typeof parsed.campaignId !== "string"
    ) {
        return {
            ok: false,
            problem: `line ${index + 1} lacks at/campaignId`,
        };
    }
    return { ok: true, event: parsed as unknown as LedgerEvent };
}

/**
 * Parse ledger text without trusting it. Missing is an explicit state, and a
 * malformed line poisons the ledger: no later event is credited.
 * @param text The exact ledger bytes, or undefined when absent.
 * @returns The parse result.
 */
export function parseLedger(text: string | undefined): LedgerRead {
    if (text === undefined) {
        return { state: "absent", events: [], problems: [], closedAt: null };
    }
    const events: LedgerEvent[] = [];
    const problems: string[] = [];
    for (const [index, line] of text.split("\n").entries()) {
        if (line.trim() === "") continue;
        const parsed = parseEventLine(line, index);
        if (parsed.ok) events.push(parsed.event);
        else problems.push(parsed.problem);
    }
    if (problems.length > 0) {
        return { state: "malformed", events, problems, closedAt: null };
    }
    const closure = events.filter((event) => event.event === "close").at(-1);
    return {
        state: closure === undefined ? "open" : "closed",
        events,
        problems: [],
        closedAt: closure?.at ?? null,
    };
}

/**
 * Read the ledger from a campaign root.
 * @param root The campaign root.
 * @returns The parse result.
 */
export function readLedger(root: string): LedgerRead {
    const path = ledgerPath(root);
    if (!existsSync(path)) return parseLedger(undefined);
    try {
        return parseLedger(readFileSync(path, "utf8"));
    } catch (error) {
        return {
            state: "malformed",
            events: [],
            problems: [
                `ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`,
            ],
            closedAt: null,
        };
    }
}

/**
 * Append one event. The caller owns the decision that the ledger is open;
 * this helper only writes a complete line.
 * @param root The campaign root.
 * @param event The event without the stamp.
 * @param at The event time; defaults to now.
 * @returns The written event.
 */
export function appendLedgerEvent(
    root: string,
    event: { event: LedgerEventName; campaignId: string } & Record<
        string,
        unknown
    >,
    at = new Date().toISOString(),
): LedgerEvent {
    const path = ledgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    const written: LedgerEvent = { schemaVersion: 1, ...event, at };
    appendFileSync(path, `${JSON.stringify(written)}\n`, "utf8");
    return written;
}

/** Count the trial launches recorded in a ledger. */
export function trialStarts(events: readonly LedgerEvent[]): LedgerEvent[] {
    return events.filter((event) => event.event === "trial-start");
}

/** Count the durable assessments recorded in a ledger. */
export function assessmentEvents(
    events: readonly LedgerEvent[],
): LedgerEvent[] {
    return events.filter((event) => event.event === "assessment");
}

/** The slot ids that have started, in order. */
export function startedSlots(events: readonly LedgerEvent[]): string[] {
    return trialStarts(events)
        .map((event) =>
            typeof event.slotId === "string" ? event.slotId : null,
        )
        .filter((slot): slot is string => slot !== null);
}

/** Why a launch is refused by ledger/budget state, or null when permitted. */
export function launchRefusal(
    read: LedgerRead,
    budget: { trials: number },
): string | null {
    if (read.state === "malformed") {
        return `attempt ledger is malformed: ${read.problems.join("; ")}`;
    }
    if (read.state === "closed") {
        return "campaign is closed; no further dispatch is permitted";
    }
    if (trialStarts(read.events).length >= budget.trials) {
        return `trial budget exhausted (${budget.trials})`;
    }
    return null;
}
