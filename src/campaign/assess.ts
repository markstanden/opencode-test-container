import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Of } from "../contracts/canonical.ts";
import { isRecord } from "../contracts/validate.ts";
import { loadPreparedManifest, type PreparedManifest } from "./prepare.ts";
import { loadFrozen } from "./freeze.ts";
import { appendLedgerEvent, readLedger } from "./ledger.ts";
import { trialDirectory } from "./run.ts";
import type { Slot } from "../contracts/types.ts";
import { assessSkillTrial } from "../evaluators/skills/assess.ts";
import { assessDocsTrial } from "../evaluators/docs/assess.ts";

/** One stored assessment. */
export type StoredAssessment =
    ReturnType<typeof assessSkillTrial> | ReturnType<typeof assessDocsTrial>;

/** Aggregate counts for a status/report line. */
export interface AssessmentSummary {
    /** The assessed value. */
    assessed: number;
    /** The pass value. */
    pass: number;
    /** The fail value. */
    fail: number;
    /** The unknown value. */
    unknown: number;
    /** The invalid value. */
    invalid: number;
    /** The unrun value. */
    unrun: number;
}

/** The result of one assess invocation. */
export interface AssessResult {
    /** The ok value. */
    ok: boolean;
    /** The summary value. */
    summary: AssessmentSummary;
    /** The problems value. */
    problems: string[];
}

/** An empty aggregate. */
function emptySummary(): AssessmentSummary {
    return { assessed: 0, pass: 0, fail: 0, unknown: 0, invalid: 0, unrun: 0 };
}

/** Path of one deterministic assessment. */
export function assessmentPath(root: string, slotId: string): string {
    return join(root, "evidence", "assessments", `${slotId}.json`);
}

/**
 * Write an assessment immutably: an existing different record is refused, not
 * overwritten. Reassessing unchanged evidence is idempotent.
 * @param path The assessment path.
 * @param assessment The assessment to store.
 * @returns Null on success, or the refusal.
 */
function storeAssessment(
    path: string,
    assessment: StoredAssessment,
): string | null {
    const text = `${JSON.stringify(assessment, null, 2)}\n`;
    if (!existsSync(path)) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, text, "utf8");
        return null;
    }
    const existing = readFileSync(path, "utf8");
    try {
        const parsed: unknown = JSON.parse(existing);
        if (
            isRecord(parsed) &&
            canonicalJson(parsed) === canonicalJson(assessment)
        ) {
            return null;
        }
    } catch {
        return `${path} is unreadable; refusing to overwrite it`;
    }
    return `${path} already holds a different assessment; historical assessments are immutable`;
}

/** Tally one assessment. */
function tally(summary: AssessmentSummary, assessment: StoredAssessment): void {
    summary.assessed += 1;
    switch (assessment.outcome) {
        case "pass":
            summary.pass += 1;
            break;
        case "fail":
            summary.fail += 1;
            break;
        default:
            summary.unknown += 1;
    }
    if (assessment.validity === "invalid") summary.invalid += 1;
    if (assessment.validity === "unrun") summary.unrun += 1;
}

/**
 * Deterministically assess every scheduled slot from captured evidence.
 * Deterministic suites make zero model calls.
 * @param root The frozen campaign root.
 * @param options Slot selection and injected clock.
 * @returns Aggregate counts and any refusals.
 * @param options.slotIds The slotIds value.
 * @param options.now The now value.
 */
/** Why assessment is refused now, or null when it may proceed. */
function assessmentRefusal(root: string): string | null {
    const frozen = loadFrozen(root);
    if (!frozen.ok) return frozen.problem;
    const ledger = readLedger(root);
    return ledger.state === "malformed"
        ? `attempt ledger is malformed: ${ledger.problems.join("; ")}`
        : null;
}

/** Build the deterministic assessment for one slot. */
function assessmentForSlot(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
    now: () => string,
): StoredAssessment | null {
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (testCase === undefined) return null;
    const trialDir = trialDirectory(root, slot.slotId);
    const common = {
        campaignId: manifest.campaignId,
        slotId: slot.slotId,
        caseId: slot.caseId,
        armId: slot.armId,
        repetitionId: slot.repetitionId,
        attemptId: `deterministic-${slot.slotId}`,
        assessedAt: now(),
    };
    if (testCase.kind === "skill-trigger") {
        return assessSkillTrial({ ...common, testCase, trialDir });
    }
    const preparedCase = manifest.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    return assessDocsTrial({
        ...common,
        testCase,
        trialDir,
        workspace: join(trialDir, "workspace"),
        prepared: new Map(
            (preparedCase?.workspace ?? []).map((entry) => [
                entry.path,
                entry.sha256,
            ]),
        ),
    });
}

/**
 * Deterministically assess every scheduled slot from captured evidence.
 * Deterministic suites make zero model calls.
 * @param root The frozen campaign root.
 * @param options Slot selection and injected clock.
 * @returns Aggregate counts and any refusals.
 * @param options.slotIds The slotIds value.
 * @param options.now The now value.
 */
/** Store one assessment and append its ledger event once. */
function recordAssessment(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
    now: () => string,
    recorded: Set<string>,
): { assessment: StoredAssessment | null; problems: string[] } {
    const assessment = assessmentForSlot(root, manifest, slot, now);
    if (assessment === null) {
        return {
            assessment: null,
            problems: [`slot ${slot.slotId} has no case ${slot.caseId}`],
        };
    }
    const refusal = storeAssessment(
        assessmentPath(root, slot.slotId),
        assessment,
    );
    if (refusal !== null) {
        return { assessment: null, problems: [refusal] };
    }
    if (!recorded.has(assessment.attemptId)) {
        appendLedgerEvent(
            root,
            {
                event: "assessment",
                campaignId: manifest.campaignId,
                slotId: slot.slotId,
                attemptId: assessment.attemptId,
                outcome: assessment.outcome,
                validity: assessment.validity,
                assessmentSha256: sha256Of(assessment),
            },
            assessment.assessedAt,
        );
        recorded.add(assessment.attemptId);
    }
    return { assessment, problems: [] };
}

/**
 * Deterministically assess every scheduled slot from captured evidence.
 * Deterministic suites make zero model calls.
 * @param root The frozen campaign root.
 * @param options Slot selection and injected clock.
 * @param options.slotIds The selected slots.
 * @param options.now The injected clock.
 * @returns Aggregate counts and any refusals.
 */
export function assessCampaign(
    root: string,
    options: { slotIds?: readonly string[]; now?: () => string } = {},
): AssessResult {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) {
        return {
            ok: false,
            summary: emptySummary(),
            problems: [prepared.problem],
        };
    }
    const refusal = assessmentRefusal(root);
    if (refusal !== null) {
        return { ok: false, summary: emptySummary(), problems: [refusal] };
    }
    const ledger = readLedger(root);
    const now = options.now ?? (() => new Date().toISOString());
    const summary = emptySummary();
    const problems: string[] = [];
    const recorded = new Set(
        ledger.events
            .filter((event) => event.event === "assessment")
            .map((event) =>
                typeof event.attemptId === "string" ? event.attemptId : "",
            ),
    );
    const manifest = prepared.manifest;
    const slots = manifest.campaign.schedule.slots.filter(
        (slot) =>
            options.slotIds === undefined ||
            options.slotIds.includes(slot.slotId),
    );
    for (const slot of slots) {
        const result = recordAssessment(root, manifest, slot, now, recorded);
        problems.push(...result.problems);
        if (result.assessment !== null) tally(summary, result.assessment);
    }
    return { ok: problems.length === 0, summary, problems };
}

/** Read all stored assessments, sorted by slot id. */
export function readAssessments(root: string): StoredAssessment[] {
    const directory = join(root, "evidence", "assessments");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .flatMap((name) => {
            try {
                const value: unknown = JSON.parse(
                    readFileSync(join(directory, name), "utf8"),
                );
                return isRecord(value)
                    ? [value as unknown as StoredAssessment]
                    : [];
            } catch {
                return [];
            }
        });
}
