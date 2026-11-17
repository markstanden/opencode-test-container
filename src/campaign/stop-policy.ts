/**
 * Versioned stop-on-first-failure policy.
 *
 * The boolean enables stopping; the version decides what a stage treats as a
 * terminal failure. Legacy roots (no `stopPolicy`) keep version 1 so an old
 * frozen campaign is never silently reinterpreted.
 *
 * Truth table for version 2:
 *
 * | Stage      | Stops after                                              |
 * | ---------- | -------------------------------------------------------- |
 * | run        | invalid capture, non-zero exit, or a declared primary |
 * |            | checker that did not pass                                |
 * | assess     | a deterministic fail or invalid assessment               |
 * | judge      | a valid adverse verdict, or an operational refusal/error |
 *
 * Version 1: run stops on capture/exit only; assess never stops; judge stops
 * on any recorded problem.
 */
import type { Campaign } from "../contracts/types.ts";
import type { StoredAssessment } from "./assess.ts";

/** The supported stop-policy versions. */
export type StopPolicyVersion = 1 | 2;

/** The version a campaign declares, defaulting to legacy semantics. */
export function stopPolicyVersion(campaign: Campaign): StopPolicyVersion {
    return campaign.stopPolicy?.version === 2 ? 2 : 1;
}

/** The terminal facts one run stage observes. */
export interface RunTerminal {
    /** Whether the raw capture was valid. */
    captureValid: boolean;
    /** The container exit status, or null when it never reported one. */
    exit: number | null;
    /** The declared primary checker's status, or null when none ran. */
    primaryStatus: string | null;
}

/** Whether the run stage stops after this slot. */
export function runShouldStop(
    campaign: Campaign,
    terminal: RunTerminal,
): boolean {
    if (campaign.stopOnFirstFailure !== true) return false;
    const operational = !terminal.captureValid || terminal.exit !== 0;
    if (stopPolicyVersion(campaign) === 1) return operational;
    return (
        operational ||
        (terminal.primaryStatus !== null && terminal.primaryStatus !== "pass")
    );
}

/** Whether the assess stage stops after this slot. */
export function assessShouldStop(
    campaign: Campaign,
    assessment: StoredAssessment,
): boolean {
    if (campaign.stopOnFirstFailure !== true) return false;
    if (stopPolicyVersion(campaign) === 1) return false;
    return assessment.outcome === "fail" || assessment.validity === "invalid";
}

/** Whether the judge stage stops after this slot. */
export function judgeShouldStop(
    campaign: Campaign,
    result: { problems: readonly string[]; adverse: boolean },
): boolean {
    if (campaign.stopOnFirstFailure !== true) return false;
    if (stopPolicyVersion(campaign) === 1) return result.problems.length > 0;
    return result.problems.length > 0 || result.adverse;
}

/** Documentation outcomes that count as an adverse judge verdict. */
export function isAdverseOutcome(outcome: unknown): boolean {
    return outcome === "none" || outcome === "misleading";
}
