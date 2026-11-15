import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../contracts/canonical.ts";
import type { SuiteCase } from "../../contracts/types.ts";
import { isRecord } from "../../contracts/validate.ts";
import type { TrialMeta } from "../../campaign/run.ts";
import { decodeTrail, type Usage } from "../../adapters/opencode/events.ts";
import {
    hostDispatchesFromTrail,
    journalIdentityFromTrail,
    verifyOperationsJournal,
    type JournalDispatch,
    type JournalVerification,
} from "./journal.ts";
import {
    readPrimaryCheck,
    type PrimaryCheckRecord,
} from "../../campaign/primary.ts";

/** The one docs case shape. */
type DocsCase = Extract<SuiteCase, { kind: "docs-task" }>;

/** The evidence states the deterministic docs evaluator can establish. */
export type DocsValidity = "valid" | "invalid" | "unknown" | "unrun";

/** The deterministic docs criterion verdict. */
export type DocsOutcome = "pass" | "fail" | "unknown";

/** The docs operation a journal record proves. */
export type DocsVerb = "search" | "add" | "read" | "check" | "help" | "other";

/** Exact counts, with attempted and verified writes kept distinct. */
export interface DocsCounts {
    /** The credited calls value. */
    creditedCalls: number;
    /** The credited writes value. */
    creditedWrites: number;
    /** The attempted writes value. */
    attemptedWrites: number;
    /** The rejected lines value. */
    rejectedLines: number;
    /** The search calls value. */
    searchCalls: number;
}

/** The deterministic assessment of one docs-recording trial. */
export interface DocsAssessment {
    /** The schema version value. */
    schemaVersion: 1;
    /** The kind value. */
    kind: "docs-recording";
    /** The campaign id value. */
    campaignId: string;
    /** The slot id value. */
    slotId: string;
    /** The case id value. */
    caseId: string;
    /** The arm id value. */
    armId: string;
    /** The repetition id value. */
    repetitionId: string;
    /** The attempt id value. */
    attemptId: string;
    /** The expected value. */
    expected: DocsCase["expectedDocs"]["kind"];
    /** The validity value. */
    validity: DocsValidity;
    /** The outcome value. */
    outcome: DocsOutcome;
    /** The counts value. */
    counts: DocsCounts;
    /** The journal value. */
    journal: {
        state: JournalVerification["state"];
        credited: number;
        rejected: number;
        problems: string[];
    };
    /** The target value. */
    target: string | null;
    /** The independent primary-check result, or null when none was declared. */
    primary: {
        id: string;
        status: PrimaryCheckRecord["status"];
        exit: number | null;
    } | null;
    /** The reasons value. */
    reasons: string[];
    /** The usage value. */
    usage: Usage | null;
    /** The answered value. */
    answered: boolean;
    /** The assessed at value. */
    assessedAt: string;
}

/** Determine which docs verb one host input names. */
export function docsVerbOf(input: unknown): DocsVerb {
    if (!isRecord(input)) return "other";
    if (input.add !== undefined) return "add";
    if (input.search !== undefined) return "search";
    if (input.read !== undefined) return "read";
    if (input.check !== undefined) return "check";
    if (input.help !== undefined) return "help";
    return "other";
}

/** The metadata a served docs result carried. */
function resultMetadata(
    record: Record<string, unknown>,
): Record<string, unknown> {
    const result = record.result;
    return isRecord(result) && isRecord(result.metadata) ? result.metadata : {};
}

/** Whether a credited record proves a completed write and where. */
export function creditedWriteOf(
    record: Record<string, unknown>,
): { path: string | null; mode: string | null } | null {
    if (resultMetadata(record).written !== true) return null;
    const metadata = resultMetadata(record);
    const input = isRecord(record.input) ? record.input : {};
    const add = input.add;
    const mode =
        typeof add === "string"
            ? "create"
            : isRecord(add) && typeof add.mode === "string"
              ? add.mode
              : null;
    return {
        path: typeof metadata.path === "string" ? metadata.path : null,
        mode,
    };
}

/** Read meta without trusting it. */
function readMeta(path: string): TrialMeta | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(value) ? (value as unknown as TrialMeta) : null;
    } catch {
        return null;
    }
}

/** Read usage without trusting it. */
function readUsage(path: string): Usage | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(value) ? (value as unknown as Usage) : null;
    } catch {
        return null;
    }
}

/** Read the captured journal lines, or undefined when no file was written. */
function journalLines(path: string): string[] | undefined {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8").split("\n");
}

/** Read the per-run signing key, or null when unavailable. */
function journalKey(path: string): string | null {
    if (!existsSync(path)) return null;
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
}

/** Check retained and omitted text in one written file. */
function textReasons(
    target: string,
    text: string,
    testCase: DocsCase,
): string[] {
    const retained = (testCase.expectedDocs.retains ?? []).flatMap((value) =>
        text.includes(value)
            ? []
            : [`${target} does not retain ${JSON.stringify(value)}`],
    );
    const omitted = (testCase.expectedDocs.omits ?? []).flatMap((value) =>
        text.includes(value)
            ? [`${target} contains forbidden ${JSON.stringify(value)}`]
            : [],
    );
    const link = testCase.expectedDocs.link;
    return [
        ...retained,
        ...omitted,
        ...(link !== undefined && !text.includes(`](${link})`)
            ? [`${target} does not link ${link}`]
            : []),
    ];
}

/** Check one written file's required and forbidden text. */
function contentReasons(workspace: string, testCase: DocsCase): string[] {
    const target = testCase.expectedDocs.target;
    if (target === undefined) return [];
    const path = join(workspace, testCase.lakeRoot ?? "docs", target);
    if (!existsSync(path))
        return [`expected written file ${target} is missing`];
    return textReasons(target, readFileSync(path, "utf8"), testCase);
}

/** Check paths that must not exist. */
function absentReasons(workspace: string, testCase: DocsCase): string[] {
    return (testCase.guardrails?.absent ?? []).flatMap((path) =>
        existsSync(join(workspace, path))
            ? [`guardrail path ${path} exists`]
            : [],
    );
}

/** Check paths whose prepared identity must survive unchanged. */
function unchangedReasons(
    workspace: string,
    testCase: DocsCase,
    prepared: ReadonlyMap<string, string>,
): string[] {
    return (testCase.guardrails?.unchanged ?? []).flatMap((path) => {
        const expected = prepared.get(path);
        if (expected === undefined) {
            return [`guardrail path ${path} has no prepared identity`];
        }
        const current = join(workspace, path);
        if (!existsSync(current)) return [`guardrail path ${path} was removed`];
        return sha256Bytes(readFileSync(current)) === expected
            ? []
            : [`guardrail path ${path} changed`];
    });
}

/** Check guardrails against the final workspace and prepared inventory. */
function guardrailReasons(
    workspace: string,
    testCase: DocsCase,
    prepared: ReadonlyMap<string, string>,
): string[] {
    return [
        ...absentReasons(workspace, testCase),
        ...unchangedReasons(workspace, testCase, prepared),
    ];
}

/** The readable parts of one docs operation input. */
function operationInputParts(input: Record<string, unknown>): string[] {
    const parts: string[] = [];
    if (typeof input.search === "string")
        parts.push(`search "${input.search}"`);
    if (typeof input.read === "string") parts.push(`read ${input.read}`);
    if (typeof input.check === "string") parts.push(`check ${input.check}`);
    const add = input.add;
    if (typeof add === "object" && add !== null) {
        const declaration = add as Record<string, unknown>;
        parts.push(
            `${String(declaration.mode ?? "create")} ${String(declaration.path ?? "(body)")}`,
        );
    }
    return parts;
}

/** One verified docs operation, rendered for the judge. */
function operationLine(entry: Record<string, unknown>): string {
    const surface = entry.surface === "codemode-twin" ? "twin" : "native";
    const input =
        typeof entry.input === "object" && entry.input !== null
            ? (entry.input as Record<string, unknown>)
            : {};
    const parts = operationInputParts(input);
    return `${String(entry.status ?? "unknown")} ${surface} ${parts.join("; ") || "help"}`;
}

/** Verify the captured journal against the host trail. */
function verificationOf(
    trialDir: string,
    events: string,
    tools: string,
): JournalVerification {
    const host = hostDispatchesFromTrail(tools);
    return verifyOperationsJournal({
        lines: journalLines(join(trialDir, "journal", "docs-operations.jsonl")),
        key: journalKey(join(trialDir, "journal-key.txt")),
        identity: journalIdentityFromTrail(events),
        callIds: host.callIds,
        nativeCalls: host.nativeCalls,
        dispatches: host.dispatches,
    });
}

/** Whether an absent journal contradicts the case's declared operation need. */
function journalAbsenceProblem(
    testCase: DocsCase,
    verification: JournalVerification,
    host: ReturnType<typeof hostDispatchesFromTrail>,
): string | null {
    if (verification.state !== "absent") {
        return verification.state === "verified"
            ? null
            : `docs journal is ${verification.state}; no operation is credited`;
    }
    const dispatched = host.nativeCalls.length + host.dispatches.length;
    const expectsOperations =
        (testCase.criterion?.minVerifiedCalls ?? 0) > 0 ||
        testCase.expectedDocs.kind !== "none";
    return dispatched > 0 || expectsOperations
        ? "docs journal is absent; no operation is credited"
        : null;
}

/** Capture integrity problems for a docs trial. */
function docsIntegrity(
    testCase: DocsCase,
    meta: TrialMeta,
    verification: JournalVerification,
    host: ReturnType<typeof hostDispatchesFromTrail>,
): string[] {
    const integrity: string[] = [];
    if (meta.captureValid !== true)
        integrity.push(...(meta.captureProblems ?? []));
    if (meta.exit !== 0)
        integrity.push(`container exited ${String(meta.exit)}`);
    const absence = journalAbsenceProblem(testCase, verification, host);
    if (absence !== null) integrity.push(absence);
    if (verification.rejected.length > 0) {
        integrity.push(
            `${verification.rejected.length} journal line(s) were rejected: ${verification.rejected
                .map((entry) => entry.reason)
                .join(", ")}`,
        );
    }
    return integrity;
}

/** Why a declared primary check stops assessment before the criterion. */
function primarySeparation(
    testCase: DocsCase,
    record: PrimaryCheckRecord | null,
): { validity: "invalid" | "unknown"; reasons: string[] } | null {
    if (testCase.primaryCheck === undefined || record === null) {
        return testCase.primaryCheck === undefined
            ? null
            : {
                  validity: "invalid",
                  reasons: [
                      `primary check ${testCase.primaryCheck.id} has no recorded result`,
                  ],
              };
    }
    return record.status === "timeout" || record.status === "error"
        ? {
              validity: "unknown",
              reasons: [
                  `primary check ${record.id} ${record.status}: ${record.reason ?? record.stderr.trim()}`,
              ],
          }
        : null;
}

/** A failed primary check adds one non-compensable criterion reason. */
function primaryFailure(record: PrimaryCheckRecord | null): string[] {
    return record !== null && record.status === "fail"
        ? [`primary check ${record.id} failed (exit ${String(record.exit)})`]
        : [];
}

/** Apply the docs criterion to credited evidence and the final workspace. */
function docsReasons(
    testCase: DocsCase,
    credited: readonly Record<string, unknown>[],
    writes: ReadonlyArray<{ path: string | null; mode: string | null }>,
    workspace: string,
    prepared: ReadonlyMap<string, string>,
): string[] {
    const criterion = testCase.criterion ?? { minVerifiedCalls: 0 };
    const verbs = new Set(criterion.verbs ?? []);
    const creditedForCriterion = credited.filter(
        (record) => verbs.size === 0 || verbs.has(docsVerbOf(record.input)),
    ).length;
    const reasons: string[] = [];
    if (creditedForCriterion < criterion.minVerifiedCalls) {
        reasons.push(
            `verified calls ${creditedForCriterion} below required ${criterion.minVerifiedCalls}`,
        );
    }
    if (testCase.expectedDocs.kind === "none") {
        if (writes.length > 0) {
            reasons.push(
                `${writes.length} write(s) were credited; this case expects refusal`,
            );
        }
    } else {
        const target = testCase.expectedDocs.target;
        const match = writes.find(
            (write) =>
                write.path === target &&
                (testCase.expectedDocs.kind === "create"
                    ? write.mode === "create" || write.mode === null
                    : write.mode === "replace"),
        );
        if (match === undefined) {
            reasons.push(
                `no credited ${testCase.expectedDocs.kind} write to ${String(target)}`,
            );
        }
        reasons.push(...contentReasons(workspace, testCase));
    }
    reasons.push(...guardrailReasons(workspace, testCase, prepared));
    return reasons;
}

/**
 * Assess one docs-recording trial from the signed journal and the uploaded
 * workspace. The journal is the only route that credits a served operation;
 * an attempted but refused write retains zero recording credit.
 * @param options Trial identity, case definition, evidence and workspace.
 * @returns The assessment.
 * @param options.campaignId The campaignId value.
 * @param options.slotId The slotId value.
 * @param options.caseId The caseId value.
 * @param options.armId The armId value.
 * @param options.repetitionId The repetitionId value.
 * @param options.testCase The testCase value.
 * @param options.trialDir The trialDir value.
 * @param options.workspace The workspace value.
 * @param options.prepared The prepared value.
 * @param options.attemptId The attemptId value.
 * @param options.assessedAt The assessedAt value.
 */
export function assessDocsTrial(options: {
    campaignId: string;
    slotId: string;
    caseId: string;
    armId: string;
    repetitionId: string;
    testCase: DocsCase;
    trialDir: string;
    workspace: string;
    prepared: ReadonlyMap<string, string>;
    attemptId: string;
    assessedAt: string;
}): DocsAssessment {
    const { testCase, trialDir } = options;
    const meta = readMeta(join(trialDir, "meta.json"));
    const primaryRecord = readPrimaryCheck(trialDir);
    const primary =
        primaryRecord === null
            ? null
            : {
                  id: primaryRecord.id,
                  status: primaryRecord.status,
                  exit: primaryRecord.exit,
              };
    const base = {
        schemaVersion: 1 as const,
        kind: "docs-recording" as const,
        campaignId: options.campaignId,
        slotId: options.slotId,
        caseId: options.caseId,
        armId: options.armId,
        repetitionId: options.repetitionId,
        attemptId: options.attemptId,
        expected: testCase.expectedDocs.kind,
    };
    const empty: DocsCounts = {
        creditedCalls: 0,
        creditedWrites: 0,
        attemptedWrites: 0,
        rejectedLines: 0,
        searchCalls: 0,
    };
    if (meta === null || !existsSync(join(trialDir, "events.jsonl"))) {
        return {
            ...base,
            validity: "unrun",
            outcome: "unknown",
            counts: empty,
            journal: {
                state: "absent",
                credited: 0,
                rejected: 0,
                problems: ["trial evidence is missing"],
            },
            target: null,
            primary,
            reasons: ["trial evidence is missing"],
            usage: null,
            answered: false,
            assessedAt: options.assessedAt,
        };
    }
    const events = readFileSync(join(trialDir, "events.jsonl"), "utf8");
    const trail = decodeTrail(events);
    const tools = existsSync(join(trialDir, "tools.jsonl"))
        ? readFileSync(join(trialDir, "tools.jsonl"), "utf8")
        : "";
    const host = hostDispatchesFromTrail(tools);
    const verification = verificationOf(trialDir, events, tools);
    const credited = verification.credited.map((entry) => entry.record);
    const writes = credited
        .map(creditedWriteOf)
        .filter(
            (entry): entry is { path: string | null; mode: string | null } =>
                entry !== null,
        );
    const counts: DocsCounts = {
        creditedCalls: credited.length,
        creditedWrites: writes.length,
        attemptedWrites: countAttemptedWrites(host, verification),
        rejectedLines: verification.rejected.length,
        searchCalls: credited.filter(
            (record) => docsVerbOf(record.input) === "search",
        ).length,
    };
    const integrity = docsIntegrity(testCase, meta, verification, host);
    if (integrity.length > 0) {
        return {
            ...base,
            validity: "invalid",
            outcome: "unknown",
            counts,
            journal: journalSummary(verification),
            target: null,
            primary,
            reasons: integrity,
            usage: readUsage(join(trialDir, "usage.json")),
            answered: trail.text.trim() !== "",
            assessedAt: options.assessedAt,
        };
    }
    const separation = primarySeparation(testCase, primaryRecord);
    if (separation !== null) {
        return {
            ...base,
            validity: separation.validity,
            outcome: "unknown",
            counts,
            journal: journalSummary(verification),
            target: null,
            primary,
            reasons: separation.reasons,
            usage: readUsage(join(trialDir, "usage.json")),
            answered: trail.text.trim() !== "",
            assessedAt: options.assessedAt,
        };
    }
    const reasons = docsReasons(
        testCase,
        credited,
        writes,
        options.workspace,
        options.prepared,
    );
    reasons.push(...primaryFailure(primaryRecord));
    const outcome: DocsOutcome = reasons.length === 0 ? "pass" : "fail";
    return {
        ...base,
        validity: "valid",
        outcome,
        counts,
        journal: journalSummary(verification),
        target: testCase.expectedDocs.target ?? null,
        primary,
        reasons,
        usage: readUsage(join(trialDir, "usage.json")),
        answered: trail.text.trim() !== "",
        assessedAt: options.assessedAt,
    };
}

/** Count add attempts, including refused ones and rejected journal lines. */
function countAttemptedWrites(
    host: ReturnType<typeof hostDispatchesFromTrail>,
    verification: JournalVerification,
): number {
    const native = host.nativeCalls.filter(
        (dispatch: JournalDispatch) => docsVerbOf(dispatch.input) === "add",
    ).length;
    const nested = host.dispatches.filter(
        (dispatch: JournalDispatch) => docsVerbOf(dispatch.input) === "add",
    ).length;
    return Math.max(native + nested, verification.rejected.length);
}

/** The compact journal summary a report carries. */
export function journalSummary(
    verification: JournalVerification,
): DocsAssessment["journal"] {
    return {
        state: verification.state,
        credited: verification.credited.length,
        rejected: verification.rejected.length,
        problems: verification.problems,
    };
}

/**
 * The judge-visible docs operations for one trial: credited journal records
 * only. An unattributable journal yields no lines and an explicit problem.
 * @param trialDir The trial evidence directory.
 * @returns The rendered operations and the verification state.
 */
export function creditedOperationLines(trialDir: string): {
    state: JournalVerification["state"];
    lines: string[];
    problems: string[];
} {
    if (!existsSync(join(trialDir, "journal", "docs-operations.jsonl"))) {
        return { state: "absent", lines: [], problems: [] };
    }
    const events = existsSync(join(trialDir, "events.jsonl"))
        ? readFileSync(join(trialDir, "events.jsonl"), "utf8")
        : "";
    const tools = existsSync(join(trialDir, "tools.jsonl"))
        ? readFileSync(join(trialDir, "tools.jsonl"), "utf8")
        : "";
    const verification = verificationOf(trialDir, events, tools);
    const lines = verification.credited.map((entry) =>
        operationLine(entry.record),
    );
    return {
        state: verification.state,
        lines,
        problems: verification.problems,
    };
}
