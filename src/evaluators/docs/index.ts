/**
 * The docs evaluator: checked recording, utility, retrieval, preservation,
 * guardrails, pairing, bounds, screening, decision and rendering semantics.
 *
 * These modules are the established analysis implementation, migrated from
 * the docs plugin with their tests. They consume recorded evidence only; none
 * of them calls a model.
 */

export { runAnalysis } from "./analysis/replay.ts";
export * from "./analysis/accounting.ts";
export * from "./analysis/bounds.ts";
export * from "./analysis/decision.ts";
export * from "./analysis/guardrails.ts";
export * from "./analysis/measures.ts";
export * from "./analysis/model.ts";
export * from "./analysis/pairing.ts";
export * from "./analysis/records.ts";
export * from "./analysis/render.ts";
export * from "./analysis/screening/rules.ts";
export * from "./analysis/screening/scan.ts";
export * from "./analysis/screening/inventory.ts";
export * from "./analysis/screening/reconcile.ts";
export {
    DOCUMENTATION_OUTCOMES,
    PRESERVATION_CASE,
    buildAcPrompt,
    finalistQualifies,
    judgeFailureClass,
    parseAcJudgement,
    rankCandidates,
    sensitivity,
    summariseArm,
    validateAcJudgement,
    type DocumentationOutcome,
    type JudgeFailureClass,
    type PreservationState,
} from "./scoring.ts";
export { assessDocsTrial } from "./assess.ts";
export { verifyOperationsJournal } from "./journal.ts";
