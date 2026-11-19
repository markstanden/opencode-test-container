import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteCase } from "../../contracts/types.ts";
import {
    bodyRoutes,
    skillCalls,
    type SkillCall,
    type Usage,
} from "../../adapters/opencode/events.ts";
import { checkCapture } from "../../evidence/capture.ts";
import {
    sourceIdentity,
    unsafeIdentityFields,
    type SourceIdentity,
} from "../../evidence/source-identity.ts";
import { EVALUATOR_VERSION } from "../../contracts/version.ts";
import { isRecord } from "../../contracts/validate.ts";

/** The evidence states the evaluator can establish. */
export type SkillValidity = "valid" | "invalid" | "unknown" | "unrun";

/** What the trail showed, independent of the expected outcome. */
export type SkillObservation =
    | "target-activation"
    | "attempted-target-load"
    | "failed-target-load"
    | "other-skill-only"
    | "no-invocation";

/** The criterion verdict. */
export type SkillOutcome = "pass" | "fail" | "unknown";

/** Exact counts, never collapsed into a single score. */
export interface SkillCounts {
    /** The requested target value. */
    requestedTarget: number;
    /** The successful target value. */
    successfulTarget: number;
    /** The failed target value. */
    failedTarget: number;
    /** The other skill value. */
    otherSkill: number;
    /** The total skill calls value. */
    totalSkillCalls: number;
}

/** The deterministic assessment of one skill-trigger trial. */
export interface SkillAssessment {
    /** The schema version value. */
    schemaVersion: 1;
    /** The evaluator semantics that produced this assessment. */
    evaluatorVersion: number;
    /** The exact trial artifacts this assessment consumed. */
    evidence: SourceIdentity;
    /** The kind value. */
    kind: "skill-activation";
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
    /** The target skill id value. */
    targetSkillId: string;
    /** The expected value. */
    expected: "activation" | "no-activation";
    /** The validity value. */
    validity: SkillValidity;
    /** The observed value. */
    observed: SkillObservation | "unrun";
    /** The outcome value. */
    outcome: SkillOutcome;
    /** The counts value. */
    counts: SkillCounts;
    /** The body routes value. */
    bodyRoutes: string[];
    /** The contaminated value. */
    contaminated: boolean;
    /** The reasons value. */
    reasons: string[];
    /** The usage value. */
    usage: Usage | null;
    /** The answered value. */
    answered: boolean;
    /** The assessed at value. */
    assessedAt: string;
}

/** The zeroed count block. */
function emptyCounts(): SkillCounts {
    return {
        requestedTarget: 0,
        successfulTarget: 0,
        failedTarget: 0,
        otherSkill: 0,
        totalSkillCalls: 0,
    };
}

/** Split skill calls into target and other counts. */
function countsOf(
    calls: readonly SkillCall[],
    targetSkillId: string,
): SkillCounts {
    const counts = emptyCounts();
    for (const call of calls) {
        counts.totalSkillCalls += 1;
        if (call.requestedId !== targetSkillId) {
            if (call.loaded) counts.otherSkill += 1;
            continue;
        }
        counts.requestedTarget += 1;
        if (call.loaded) counts.successfulTarget += 1;
        else counts.failedTarget += 1;
    }
    return counts;
}

/** Read the usage record, or null when absent/malformed. */
function readUsage(path: string): Usage | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(value) ? (value as unknown as Usage) : null;
    } catch {
        return null;
    }
}

/** An unrun assessment with no usable evidence. */
function unrunAssessment(
    base: Omit<
        SkillAssessment,
        | "validity"
        | "observed"
        | "outcome"
        | "counts"
        | "bodyRoutes"
        | "contaminated"
        | "reasons"
        | "usage"
        | "answered"
        | "assessedAt"
    >,
    reason: string,
    assessedAt: string,
): SkillAssessment {
    return {
        ...base,
        validity: "unrun",
        observed: "unrun",
        outcome: "unknown",
        counts: emptyCounts(),
        bodyRoutes: [],
        contaminated: false,
        reasons: [reason],
        usage: null,
        answered: false,
        assessedAt,
    };
}

/** Reasons an unsafe evaluated workspace makes integrity unknown. */
function unsafeWorkspaceReasons(evidence: {
    workspacePresent: boolean;
    workspaceSafe: boolean;
}): string[] {
    return evidence.workspacePresent && !evidence.workspaceSafe
        ? [
              "the evaluated workspace contains an unsafe object; integrity is unknown",
          ]
        : [];
}

/** The observed state independent of expectation. */
function observationOf(counts: SkillCounts): SkillObservation {
    if (counts.successfulTarget > 0) return "target-activation";
    if (counts.otherSkill > 0) return "other-skill-only";
    return "no-invocation";
}

/** The criterion outcome for a valid observation. */
function outcomeOf(
    expected: "activation" | "no-activation",
    counts: SkillCounts,
): SkillOutcome {
    const activated = counts.successfulTarget > 0;
    return (expected === "activation") === activated ? "pass" : "fail";
}

/**
 * Assess one skill-trigger trial from checked evidence. Capture validity and
 * criterion outcome are distinct: a complete run with no target activation is
 * an observed negative; an unreadable or failed load is unknown, never a
 * passing negative.
 * @param options Trial identity, case definition and its evidence directory.
 * @returns The assessment.
 * @param options.campaignId The campaignId value.
 * @param options.slotId The slotId value.
 * @param options.caseId The caseId value.
 * @param options.armId The armId value.
 * @param options.repetitionId The repetitionId value.
 * @param options.testCase The testCase value.
 * @param options.trialDir The trialDir value.
 * @param options.attemptId The attemptId value.
 * @param options.assessedAt The assessedAt value.
 */
export function assessSkillTrial(options: {
    campaignId: string;
    slotId: string;
    caseId: string;
    armId: string;
    repetitionId: string;
    testCase: Extract<SuiteCase, { kind: "skill-trigger" }>;
    trialDir: string;
    attemptId: string;
    assessedAt: string;
}): SkillAssessment {
    const { testCase, trialDir } = options;
    const base = {
        schemaVersion: 1 as const,
        evaluatorVersion: EVALUATOR_VERSION,
        evidence: sourceIdentity(trialDir),
        kind: "skill-activation" as const,
        campaignId: options.campaignId,
        slotId: options.slotId,
        caseId: options.caseId,
        armId: options.armId,
        repetitionId: options.repetitionId,
        attemptId: options.attemptId,
        targetSkillId: testCase.targetSkillId,
        expected: testCase.expected,
    };
    return skillAssessmentFromFacts(
        base,
        testCase,
        {
            capture: checkCapture(trialDir, {
                campaignId: options.campaignId,
                slotId: options.slotId,
            }),
            usage: readUsage(join(trialDir, "usage.json")),
        },
        options.assessedAt,
    );
}

/** The checked capture and usage facts one skill decision consumes. */
export interface SkillEvidenceFacts {
    /** The checked capture, including its decoded trail. */
    capture: ReturnType<typeof checkCapture>;
    /** The trial's usage record, or null when absent or malformed. */
    usage: Usage | null;
}

/**
 * Decide one skill assessment from checked capture, source and usage facts.
 * Pure: it performs no filesystem acquisition. The caller supplies the
 * identity base and the observed facts.
 * @param base The assessment identity fields, including source identity.
 * @param testCase The skill-trigger case definition.
 * @param facts The checked capture and usage facts.
 * @param assessedAt The injected assessment time.
 * @returns The assessment.
 */
export function skillAssessmentFromFacts(
    base: Omit<
        SkillAssessment,
        | "validity"
        | "observed"
        | "outcome"
        | "counts"
        | "bodyRoutes"
        | "contaminated"
        | "reasons"
        | "usage"
        | "answered"
        | "assessedAt"
    >,
    testCase: Extract<SuiteCase, { kind: "skill-trigger" }>,
    facts: SkillEvidenceFacts,
    assessedAt: string,
): SkillAssessment {
    const { capture, usage } = facts;
    if (capture.state === "unrun") {
        return unrunAssessment(
            base,
            capture.problems[0] ?? "trial evidence is missing",
            assessedAt,
        );
    }
    const trail = capture.trail;
    const calls = skillCalls(trail);
    const counts = countsOf(calls, testCase.targetSkillId);
    const routes = bodyRoutes(trail, testCase.targetSkillId);
    const contamination = routes.length > 0;
    const unsafeFields = unsafeIdentityFields(base.evidence);
    const unsafeReasons = [
        ...unsafeWorkspaceReasons(base.evidence),
        ...unsafeFields.map(
            (field) => `trial evidence contains an unsafe object: ${field}`,
        ),
    ];
    if (unsafeReasons.length > 0) {
        return {
            ...base,
            validity: "invalid",
            observed: "unrun",
            outcome: "unknown",
            counts,
            bodyRoutes: routes,
            contaminated: contamination,
            reasons: unsafeReasons,
            usage,
            answered: trail.text.trim() !== "",
            assessedAt,
        };
    }
    if (capture.state === "invalid") {
        return {
            ...base,
            validity: "invalid",
            observed: "unrun",
            outcome: "unknown",
            counts,
            bodyRoutes: routes,
            contaminated: contamination,
            reasons: capture.problems,
            usage,
            answered: trail.text.trim() !== "",
            assessedAt,
        };
    }
    if (contamination && testCase.contamination !== "record") {
        return {
            ...base,
            validity: "invalid",
            observed:
                counts.successfulTarget > 0
                    ? "target-activation"
                    : "no-invocation",
            outcome: "unknown",
            counts,
            bodyRoutes: routes,
            contaminated: true,
            reasons: [
                `the target body was reached through ${routes.join(", ")}, not a skill-tool activation`,
            ],
            usage,
            answered: trail.text.trim() !== "",
            assessedAt,
        };
    }
    if (counts.failedTarget > 0) {
        return {
            ...base,
            validity: "unknown",
            observed: "failed-target-load",
            outcome: "unknown",
            counts,
            bodyRoutes: routes,
            contaminated: contamination,
            reasons: [
                "the target skill load failed; successful activation is unknown",
            ],
            usage,
            answered: trail.text.trim() !== "",
            assessedAt,
        };
    }
    const observed = observationOf(counts);
    const outcome = outcomeOf(testCase.expected, counts);
    return {
        ...base,
        validity: "valid",
        observed,
        outcome,
        counts,
        bodyRoutes: routes,
        contaminated: contamination,
        reasons: [],
        usage,
        answered: trail.text.trim() !== "",
        assessedAt,
    };
}
