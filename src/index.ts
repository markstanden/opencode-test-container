/**
 * @markstanden/opencode-test-container
 *
 * Public modules are re-exported here for programmatic use. The supported
 * consumer surface is the `otc` CLI; these exports exist so tests and
 * evaluators can exercise the same lifecycle without a shell.
 */

export { canonicalJson, sha256Bytes, sha256Of } from "./contracts/canonical.ts";
export {
    EVALUATOR_VERSION,
    PACKAGE_NAME,
    packageVersion,
    toolIdentity,
} from "./contracts/version.ts";
export type { ToolIdentity } from "./contracts/version.ts";
export type {
    Arm,
    AssessmentKind,
    Campaign,
    CampaignBundle,
    DocsTaskCase,
    ExpectedDocs,
    LifecycleState,
    PrimaryCheckSpec,
    ProviderRoute,
    RecoveryDeclaration,
    RuntimeSpec,
    SkillTriggerCase,
    Slot,
    Suite,
    SuiteCase,
} from "./contracts/types.ts";
export {
    ID_PATTERN,
    isId,
    isSafeRelativePath,
    loadCampaignBundle,
    validateBundle,
    validateCampaign,
    validateSuite,
} from "./contracts/validate.ts";
export {
    DEFAULT_PLUGIN_INCLUDE,
    loadPreparedManifest,
    manifestSha256,
    normaliseCampaign,
    prepareCampaign,
    preparedDifferences,
} from "./campaign/prepare.ts";
export type { PreparedManifest, StagedArm } from "./campaign/prepare.ts";
export {
    deliveryCheck,
    freezeCampaign,
    freezeDifferences,
    freezeIdentity,
    loadFrozen,
} from "./campaign/freeze.ts";
export type { FrozenRecord } from "./campaign/freeze.ts";
export {
    appendLedgerEvent,
    launchRefusal,
    parseLedger,
    readLedger,
    trialStarts,
} from "./campaign/ledger.ts";
export type { LedgerEvent, LedgerRead } from "./campaign/ledger.ts";
export {
    launchSha256,
    planTrial,
    runCampaign,
    trialDirectory,
} from "./campaign/run.ts";
export type { RunSummary, TrialMeta } from "./campaign/run.ts";
export {
    judgeCampaign,
    buildJudgePacketForSlot,
    checkedSelection,
    checkedSelectionForSlot,
    readJudgeAttempts,
    readSelectedJudgement,
    selectionPath,
} from "./campaign/judge.ts";
export type {
    CheckedSelection,
    JudgeAttemptMeta,
    JudgeSummary,
    SelectedJudgement,
    StoredJudgement,
} from "./campaign/judge.ts";
export {
    executePrimaryCheck,
    primaryCheckPlan,
    readPrimaryCheck,
} from "./campaign/primary.ts";
export type { PrimaryCheckRecord } from "./campaign/primary.ts";
export {
    assessCampaign,
    assessmentPath,
    readAssessments,
} from "./campaign/assess.ts";
export type { StoredAssessment } from "./campaign/assess.ts";
export {
    checkedAssessments,
    assessmentRecordPath,
} from "./evidence/assessments.ts";
export type {
    CheckedAssessment,
    CheckedAssessments,
} from "./evidence/assessments.ts";
export { judgeStateOf } from "./campaign/eligibility.ts";
export type {
    JudgeFacts,
    JudgeState,
    JudgeStateCode,
} from "./campaign/eligibility.ts";
export { closeCampaign } from "./campaign/close.ts";
export { statusOf } from "./campaign/status.ts";
export type { StatusReport } from "./campaign/status.ts";
export {
    analyseCampaign,
    reportIdentity,
    reportIntact,
} from "./reporting/report.ts";
export type { Report } from "./reporting/report.ts";
export {
    decodeTrail,
    captureProblems,
    skillCalls,
} from "./adapters/opencode/events.ts";
export type {
    DecodedTrail,
    SkillCall,
    Usage,
} from "./adapters/opencode/events.ts";
export {
    containerArgv,
    mountProblems,
    runContainer,
} from "./adapters/podman/container.ts";
export type { ContainerPlan, Mount } from "./adapters/podman/container.ts";
export {
    buildImage,
    containerfileText,
    parseOpencodeVersion,
    resolveImage,
} from "./adapters/podman/image.ts";
export { assessDocsTrial, docsVerbOf } from "./evaluators/docs/assess.ts";
export type { DocsAssessment } from "./evaluators/docs/assess.ts";
export * from "./evaluators/docs/index.ts";
export {
    hostDispatchesFromTrail,
    isServedRecord,
    journalIdentityFromTrail,
    journalMacValid,
    verifyOperationsJournal,
} from "./evaluators/docs/journal.ts";
export type {
    JournalDispatch,
    JournalVerification,
} from "./evaluators/docs/journal.ts";
export { assessSkillTrial } from "./evaluators/skills/assess.ts";
export type { SkillAssessment } from "./evaluators/skills/assess.ts";
export { readLegacyManifest, readLegacySchedule } from "./legacy/prod014.ts";
export type {
    LegacyManifest,
    LegacySchedule,
    LegacySlot,
} from "./legacy/prod014.ts";
export { main, parseArgs, USAGE } from "./cli/otc.ts";
