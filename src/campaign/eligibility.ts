/**
 * One judge-eligibility decision, shared by preview, status, judge and close.
 *
 * The deterministic assessment is the prerequisite for a paid judge dispatch.
 * These states preserve the intended distinctions: a valid adverse result is
 * eligible, an invalid capture or untrustworthy assessment is not, an unrun
 * slot is not, an operational failure is not, and an inconsistent selection is
 * a conflict that closure must explain rather than a slot waiting to be
 * judged.
 */
import type { PreparedManifest } from "./prepare.ts";
import type { Slot } from "../contracts/types.ts";

/** A checked assessment's facts, without the record's evaluator payload. */
export interface AssessmentFacts {
    /** The checked state: missing, valid, corrupt, unsupported or conflicting. */
    state: string;
    /** The assessment's validity and outcome, when a record was readable. */
    record: { validity: string; outcome: string } | null;
}

/** One recorded attempt's terminal classification, or `started`. */
export interface AttemptFacts {
    /** The attempt's judgement status. */
    judgementStatus: string;
}

/** Why a slot is or is not judgeable. */
export type JudgeStateCode =
    | "not-declared"
    | "not-docs"
    | "unrun"
    | "assessment-missing"
    | "assessment-untrustworthy"
    | "assessment-invalid"
    | "assessment-unknown"
    | "judged"
    | "selection-missing"
    | "selection-conflict"
    | "unsettled"
    | "terminal-failures"
    | "pending";

/** The shared eligibility decision for one slot. */
export interface JudgeState {
    /** The stable state code. */
    code: JudgeStateCode;
    /** A reason suitable for preview, status, judge and closure. */
    reason: string;
    /** Whether a first judge dispatch is admissible now. */
    dispatchable: boolean;
    /**
     * Whether closure may accept this slot without a usable selection. A
     * terminal failure is accepted under the declared all-terminal-failures
     * policy; a conflict is not.
     */
    satisfied: boolean;
}

/** The facts one eligibility decision needs. */
export interface JudgeFacts {
    /** The prepared manifest. */
    manifest: PreparedManifest;
    /** The scheduled slot. */
    slot: Slot;
    /** Whether the trial has a recorded capture. */
    trialRecorded: boolean;
    /** The checked deterministic assessment. */
    assessment: AssessmentFacts | undefined;
    /** Whether a selection record exists on disk. */
    selectionPresent: boolean;
    /** The checked selection decision. */
    selection: { ok: boolean; problems: readonly string[] };
    /** Every recorded attempt. */
    attempts: readonly AttemptFacts[];
}

/** Whether an attempt ended without a usable verdict. */
function terminalFailure(attempt: AttemptFacts): boolean {
    return (
        attempt.judgementStatus === "invalid-verdict" ||
        attempt.judgementStatus === "judge-error"
    );
}

/** Build one decision. */
function state(
    code: JudgeStateCode,
    reason: string,
    options: { dispatchable?: boolean; satisfied?: boolean } = {},
): JudgeState {
    return {
        code,
        reason,
        dispatchable: options.dispatchable ?? false,
        satisfied: options.satisfied ?? true,
    };
}

/** The assessment states that make a slot unjudgeable. */
function assessmentState(
    slotId: string,
    assessment: AssessmentFacts | undefined,
): JudgeState | null {
    if (assessment === undefined || assessment.state === "missing") {
        return state(
            "assessment-missing",
            `slot ${slotId} has no deterministic assessment; run otc assess before judging`,
        );
    }
    if (assessment.state !== "valid" || assessment.record === null) {
        return state(
            "assessment-untrustworthy",
            `slot ${slotId} has an untrustworthy deterministic assessment (${assessment.state}); no judge spend is permitted`,
        );
    }
    if (assessment.record.validity !== "valid") {
        return state(
            "assessment-invalid",
            `slot ${slotId} is ${assessment.record.validity}; only a valid capture with a checked assessment is judged`,
        );
    }
    return assessment.record.outcome === "unknown"
        ? state(
              "assessment-unknown",
              `slot ${slotId} has an unknown deterministic outcome; only a pass or fail is judged`,
          )
        : null;
}

/** The selection and attempt states, once the assessment is eligible. */
function judgementState(facts: JudgeFacts, slotId: string): JudgeState {
    if (facts.selection.ok) {
        return state(
            "judged",
            `slot ${slotId} already has a checked judgement`,
        );
    }
    if (facts.selectionPresent) {
        return state(
            "selection-conflict",
            `slot ${slotId} has an unusable selection: ${facts.selection.problems.join("; ")}`,
            { satisfied: false },
        );
    }
    if (
        facts.attempts.some((attempt) => attempt.judgementStatus === "judged")
    ) {
        // The attempt is usable, so the judge may repair the missing selection
        // by recording it. Closure may not: an earlier failed attempt must not
        // hide a later verdict whose selection is absent.
        return state(
            "selection-missing",
            `slot ${slotId} has a usable judgement but no checked selection; record the selection before closure`,
            { satisfied: false },
        );
    }
    if (facts.attempts.some((attempt) => !terminalFailure(attempt))) {
        return state(
            "unsettled",
            `slot ${slotId} has a judge attempt without a terminal record; settle it before judging again`,
            { satisfied: false },
        );
    }
    if (facts.attempts.length > 0) {
        return state(
            "terminal-failures",
            `slot ${slotId} has only terminal judge failures (${facts.attempts
                .map((attempt) => attempt.judgementStatus)
                .join(", ")})`,
        );
    }
    return state(
        "pending",
        `slot ${slotId} is eligible for an arm-blind judge`,
        { dispatchable: true, satisfied: false },
    );
}

/**
 * Decide one slot's judge state from checked facts.
 * @param facts The declaration, assessment, selection and attempts.
 * @returns The shared decision.
 */
export function judgeStateOf(facts: JudgeFacts): JudgeState {
    const { manifest, slot } = facts;
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (manifest.campaign.assessment.judge === undefined) {
        return state(
            "not-declared",
            `slot ${slot.slotId} is not judged: the campaign declares no judge`,
        );
    }
    if (testCase === undefined || testCase.kind !== "docs-task") {
        return state(
            "not-docs",
            `slot ${slot.slotId} is not a docs-task case; only docs tasks are judged`,
        );
    }
    if (!facts.trialRecorded) {
        return state("unrun", `slot ${slot.slotId} has no recorded trial`);
    }
    return (
        assessmentState(slot.slotId, facts.assessment) ??
        judgementState(facts, slot.slotId)
    );
}
