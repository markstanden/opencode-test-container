/**
 * Checked assessment records.
 *
 * A parsed JSON object is not an assessment. Every consumer that trusts
 * results (status, closure, reporting, judge selection) goes through this
 * reader, which checks the record shape, the scheduled slot identity, the
 * supported schema/evaluator version, the exact source-evidence hashes and the
 * one authoritative ledger binding.
 *
 * Limit: these are local consistency hashes. They detect an edited record or a
 * missing/duplicate ledger binding; they cannot defeat an operator who can
 * coherently rewrite every trusted record on this machine.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Of } from "../contracts/canonical.ts";
import { isRecord } from "../contracts/validate.ts";
import type { Slot } from "../contracts/types.ts";
import type { LedgerEvent, LedgerRead } from "../campaign/ledger.ts";
import type { PreparedManifest } from "../campaign/prepare.ts";
import type { StoredAssessment } from "../campaign/assess.ts";
import { trialDirectory } from "../campaign/run.ts";
import {
    sourceIdentityProblems,
    type SourceIdentity,
} from "./source-identity.ts";

/** The checked state of one slot's persisted assessment. */
export type AssessmentRecordState =
    "valid" | "missing" | "corrupt" | "unsupported" | "conflicting";

/** One slot's checked assessment. */
export interface CheckedAssessment {
    /** The scheduled slot id. */
    slotId: string;
    /** The checked state. */
    state: AssessmentRecordState;
    /** The record, when it parsed and shaped correctly. */
    record: StoredAssessment | null;
    /** Whether the record was produced by an older supported evaluator. */
    historical: boolean;
    /** What a historical record cannot prove, when applicable. */
    limitations: string[];
    /** Every consistency problem found. */
    problems: string[];
}

/** The checked assessment set for one campaign. */
export interface CheckedAssessments {
    /** One entry per scheduled slot, in schedule order. */
    records: CheckedAssessment[];
    /** Every non-missing problem, prefixed with its slot. */
    problems: string[];
}

/** The path of one slot's persisted assessment. */
export function assessmentRecordPath(root: string, slotId: string): string {
    return join(root, "evidence", "assessments", `${slotId}.json`);
}

const VALIDITIES = new Set(["valid", "invalid", "unknown", "unrun"]);
const OUTCOMES = new Set(["pass", "fail", "unknown"]);

/** The common top-level fields every assessment may carry. */
const COMMON_FIELDS = new Set([
    "schemaVersion",
    "evaluatorVersion",
    "evidence",
    "kind",
    "campaignId",
    "slotId",
    "caseId",
    "armId",
    "repetitionId",
    "attemptId",
    "validity",
    "outcome",
    "reasons",
    "usage",
    "answered",
    "assessedAt",
]);

/** Fields only the skill assessment carries. */
const SKILL_FIELDS = new Set([
    "targetSkillId",
    "expected",
    "observed",
    "counts",
    "bodyRoutes",
    "contaminated",
]);

/** Fields only the docs assessment carries. */
const DOCS_FIELDS = new Set([
    "expected",
    "counts",
    "journal",
    "target",
    "primary",
]);

/** Whether every key in a record is a known field for its kind. */
function unknownFields(
    value: Record<string, unknown>,
    allowed: ReadonlySet<string>,
): string[] {
    return Object.keys(value)
        .filter((key) => !allowed.has(key))
        .map((key) => `unexpected field ${key}`);
}

/** Check one evidence identity object. */
function evidenceProblems(value: unknown): string[] {
    if (!isRecord(value)) return ["evidence binding is not an object"];
    const fields: Array<keyof SourceIdentity> = [
        "captureSha256",
        "metaSha256",
        "toolsSha256",
        "answerSha256",
        "primarySha256",
        "journalSha256",
        "journalKeySha256",
        "workspaceSha256",
        "workspacePresent",
        "workspaceSafe",
    ];
    const problems: string[] = [];
    for (const field of fields) {
        const entry = value[field];
        if (field === "workspaceSafe" || field === "workspacePresent") {
            if (typeof entry !== "boolean") {
                problems.push(`evidence.${field} must be a boolean`);
            }
        } else if (entry !== null && typeof entry !== "string") {
            problems.push(`evidence.${field} must be a string or null`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!(fields as readonly string[]).includes(key)) {
            problems.push(`unexpected evidence field ${key}`);
        }
    }
    return problems;
}

/** Schema, kind, field and evidence-binding checks. */
/** Fields allowed for this record kind and format. */
function allowedFields(
    value: Record<string, unknown>,
    legacy: boolean,
): ReadonlySet<string> {
    const allowed = new Set(COMMON_FIELDS);
    if (legacy) {
        allowed.delete("evaluatorVersion");
        allowed.delete("evidence");
    }
    for (const field of value.kind === "skill-activation"
        ? SKILL_FIELDS
        : DOCS_FIELDS) {
        allowed.add(field);
    }
    return allowed;
}

/** Schema, kind and field checks. */
function schemaProblems(
    value: Record<string, unknown>,
    legacy: boolean,
): string[] {
    if (value.schemaVersion !== 1) {
        return [
            `unsupported assessment schemaVersion ${String(value.schemaVersion)}`,
        ];
    }
    const problems: string[] = [];
    if (value.kind !== "skill-activation" && value.kind !== "docs-recording") {
        problems.push("assessment kind is not recognised");
    }
    problems.push(...unknownFields(value, allowedFields(value, legacy)));
    if (legacy) return problems;
    return [...problems, ...versionAndEvidenceProblems(value)];
}

/** Evaluator-version and evidence-binding checks for a bound record. */
function versionAndEvidenceProblems(value: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (typeof value.evaluatorVersion !== "number") {
        problems.push("assessment has no evaluator version");
    } else if (value.evaluatorVersion !== 1 && value.evaluatorVersion !== 2) {
        problems.push(
            `unsupported evaluator version ${String(value.evaluatorVersion)}`,
        );
    }
    problems.push(...evidenceProblems(value.evidence));
    return problems;
}

/** Check the vocabulary and reason list. */
function payloadVocabulary(value: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (typeof value.validity !== "string" || !VALIDITIES.has(value.validity)) {
        problems.push("assessment validity is not recognised");
    }
    if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
        problems.push("assessment outcome is not recognised");
    }
    if (
        !Array.isArray(value.reasons) ||
        value.reasons.some((reason) => typeof reason !== "string")
    ) {
        problems.push("assessment reasons are not a string array");
    }
    return problems;
}

/** Shape checks for the result payload itself. */
function payloadProblems(value: Record<string, unknown>): string[] {
    const problems = payloadVocabulary(value);
    if (typeof value.assessedAt !== "string" || value.assessedAt === "") {
        problems.push("assessment has no assessedAt");
    }
    if (typeof value.answered !== "boolean") {
        problems.push("assessment has no answered flag");
    }
    if (!isRecord(value.counts)) {
        problems.push("assessment counts are not an object");
    }
    return problems;
}

/** Identity and kind checks against the scheduled slot. */
function scheduledProblems(
    value: Record<string, unknown>,
    slot: Slot,
    manifest: PreparedManifest,
): string[] {
    const problems: string[] = [];
    const expectedKind = manifest.campaign.assessment.kind;
    if (value.kind !== expectedKind) {
        problems.push(
            `assessment kind ${String(value.kind)} does not match the suite (${expectedKind})`,
        );
    }
    const identity: Array<[string, unknown, unknown]> = [
        ["campaignId", value.campaignId, manifest.campaignId],
        ["slotId", value.slotId, slot.slotId],
        ["caseId", value.caseId, slot.caseId],
        ["armId", value.armId, slot.armId],
        ["repetitionId", value.repetitionId, slot.repetitionId],
        ["attemptId", value.attemptId, `deterministic-${slot.slotId}`],
    ];
    for (const [field, saved, expected] of identity) {
        if (saved !== expected) {
            problems.push(
                `assessment ${field} does not match the scheduled slot`,
            );
        }
    }
    return problems;
}

/**
 * Structural and identity checks for one parsed assessment.
 * @param value The parsed JSON value.
 * @param slot The scheduled slot it claims.
 * @param manifest The prepared manifest.
 * @returns Problems; empty means the shape and identity are acceptable.
 */
/** The shape verdict, including whether the record uses the legacy format. */
export interface AssessmentShape {
    /** Every shape/identity problem found. */
    problems: string[];
    /** Whether this is an older record without a source-evidence binding. */
    historical: boolean;
}

/**
 * Structural and identity checks for one parsed assessment.
 * @param value The parsed JSON value.
 * @param slot The scheduled slot it claims.
 * @param manifest The prepared manifest.
 * @returns The shape problems and historical flag.
 */
export function assessmentShape(
    value: unknown,
    slot: Slot,
    manifest: PreparedManifest,
): AssessmentShape {
    if (!isRecord(value)) {
        return { problems: ["assessment is not an object"], historical: false };
    }
    const hasVersion = "evaluatorVersion" in value;
    const hasEvidence = "evidence" in value;
    if (hasVersion !== hasEvidence) {
        return {
            problems: ["assessment mixes the legacy and source-bound formats"],
            historical: false,
        };
    }
    const legacy = !hasVersion && !hasEvidence;
    return {
        problems: [
            ...schemaProblems(value, legacy),
            ...payloadProblems(value),
            ...scheduledProblems(value, slot, manifest),
        ],
        historical:
            legacy ||
            (typeof value.evaluatorVersion === "number" &&
                value.evaluatorVersion === 1),
    };
}

/**
 * Structural and identity problems for one parsed assessment.
 * @param value The parsed JSON value.
 * @param slot The scheduled slot it claims.
 * @param manifest The prepared manifest.
 * @returns Problems; empty means the shape and identity are acceptable.
 */
export function assessmentProblems(
    value: unknown,
    slot: Slot,
    manifest: PreparedManifest,
): string[] {
    return assessmentShape(value, slot, manifest).problems;
}

/** Find the ledger's one binding for a slot's deterministic assessment. */
function ledgerBindingProblems(
    events: readonly LedgerEvent[],
    manifest: PreparedManifest,
    slot: Slot,
    record: StoredAssessment,
): string[] {
    const bound = events.filter(
        (event) =>
            event.event === "assessment" &&
            event.slotId === slot.slotId &&
            event.campaignId === manifest.campaignId,
    );
    if (bound.length === 0) {
        return [`assessment for ${slot.slotId} has no ledger binding`];
    }
    if (bound.length > 1) {
        const hashes = new Set(bound.map((event) => event.assessmentSha256));
        return [
            hashes.size > 1
                ? `assessment for ${slot.slotId} has conflicting ledger bindings`
                : `assessment for ${slot.slotId} is bound more than once`,
        ];
    }
    const event = bound[0] as LedgerEvent;
    const problems: string[] = [];
    const expectedHash = sha256Of(record);
    if (event.assessmentSha256 !== expectedHash) {
        problems.push(
            `assessment for ${slot.slotId} does not match its ledger hash`,
        );
    }
    if (event.outcome !== record.outcome) {
        problems.push(
            `assessment for ${slot.slotId} outcome differs from its ledger event`,
        );
    }
    if (event.validity !== record.validity) {
        problems.push(
            `assessment for ${slot.slotId} validity differs from its ledger event`,
        );
    }
    if (event.attemptId !== record.attemptId) {
        problems.push(
            `assessment for ${slot.slotId} attempt differs from its ledger event`,
        );
    }
    return problems;
}

/** Check one slot's persisted assessment. */
function checkSlot(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    events: readonly LedgerEvent[];
}): CheckedAssessment {
    const { root, manifest, slot, events } = options;
    const path = assessmentRecordPath(root, slot.slotId);
    if (!existsSync(path)) {
        return {
            slotId: slot.slotId,
            state: "missing",
            record: null,
            historical: false,
            limitations: [],
            problems: [],
        };
    }
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return {
            slotId: slot.slotId,
            state: "corrupt",
            record: null,
            historical: false,
            limitations: [],
            problems: [`assessment for ${slot.slotId} is not readable JSON`],
        };
    }
    const shape = assessmentShape(value, slot, manifest);
    if (shape.problems.length > 0) {
        const unsupported = shape.problems.some(
            (problem) =>
                problem.startsWith("unsupported assessment schemaVersion") ||
                problem.startsWith("unsupported evaluator version"),
        );
        return {
            slotId: slot.slotId,
            state: unsupported ? "unsupported" : "corrupt",
            record: null,
            historical: false,
            limitations: [],
            problems: shape.problems,
        };
    }
    const record = value as unknown as StoredAssessment;
    const bound = record.evidence !== undefined;
    const problems = [
        ...(bound
            ? sourceIdentityProblems(
                  trialDirectory(root, slot.slotId),
                  record.evidence,
              )
            : []),
        ...ledgerBindingProblems(events, manifest, slot, record),
    ];
    return {
        slotId: slot.slotId,
        state: problems.length === 0 ? "valid" : "conflicting",
        record,
        historical: shape.historical,
        limitations: shape.historical
            ? [
                  "historical assessment: no source-evidence binding, so later evidence changes are not detectable",
              ]
            : [],
        problems,
    };
}

/** Files in the assessment directory that do not belong to a scheduled slot. */
function unexpectedFiles(root: string, slots: readonly Slot[]): string[] {
    const directory = join(root, "evidence", "assessments");
    if (!existsSync(directory)) return [];
    const expected = new Set(slots.map((slot) => `${slot.slotId}.json`));
    return readdirSync(directory)
        .filter((name) => !expected.has(name))
        .sort()
        .map(
            (name) =>
                `unexpected assessment record evidence/assessments/${name}`,
        );
}

/**
 * Read every scheduled slot's assessment through the checked boundary.
 * @param options The campaign root, manifest and parsed ledger.
 * @param options.root The campaign root.
 * @param options.manifest The prepared manifest.
 * @param options.ledger The parsed ledger.
 * @returns One checked record per slot, plus aggregate problems.
 */
export function checkedAssessments(options: {
    root: string;
    manifest: PreparedManifest;
    ledger: LedgerRead;
}): CheckedAssessments {
    const { root, manifest, ledger } = options;
    const slots = manifest.campaign.schedule.slots;
    const records = slots.map((slot) =>
        checkSlot({ root, manifest, slot, events: ledger.events }),
    );
    const problems = [
        ...records.flatMap((record) =>
            record.problems.map((problem) => `${record.slotId}: ${problem}`),
        ),
        ...unexpectedFiles(root, slots),
    ];
    return { records, problems };
}
