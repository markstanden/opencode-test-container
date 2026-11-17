/**
 * Versioned suite and campaign contracts.
 *
 * A suite is reusable case data plus one declared assessment kind. A campaign
 * freezes a suite reference, subjects, an explicit execution schedule and the
 * runtime/provider route. Both are plain data: no campaign field names an
 * executable, so an evidence directory can never inject code.
 */

/** The assessment implementations OTC trusts by name. */
export type AssessmentKind = "skill-activation" | "docs-recording";

/** One expected docs write outcome. */
export interface ExpectedDocs {
    /** `none` means the case expects the write to be refused. */
    kind: "create" | "replace" | "none";
    /** The lake path the write should target. */
    target?: string;
    /** A relative link the written doc should contain. */
    link?: string;
    /** Text the written doc must retain. */
    retains?: string[];
    /** Text the written doc must omit. */
    omits?: string[];
}

/** One primary check the deterministic docs evaluator must satisfy. */
export interface DocsCriterion {
    /** Verified docs calls required; zero is a valid restraint expectation. */
    minVerifiedCalls: number;
    /** Accepted docs verbs. */
    verbs?: string[];
}

/** A deterministic guardrail over the final workspace. */
export interface DocsGuardrails {
    /** Paths that must remain unchanged. */
    unchanged?: string[];
    /** Paths that must not exist. */
    absent?: string[];
}

/** Fields shared by every case kind. */
export interface CaseBase {
    /** Stable selector, unique within the suite. */
    caseId: string;
    /** The exact prompt given to the subject. */
    prompt: string;
    /** A directory copied into the trial workspace before the run. */
    fixture?: string;
    /** Inline workspace files, relative to the workspace root. */
    files?: Record<string, string>;
}

/** A case that expects a named skill to be activated, or restraint. */
export interface SkillTriggerCase extends CaseBase {
    /** The kind value. */
    kind: "skill-trigger";
    /** The exact skill identity the criterion observes. */
    targetSkillId: string;
    /** `activation` expects a successful target load; restraint expects none. */
    expected: "activation" | "no-activation";
    /** How to treat a non-skill route to the body. Default `fail`. */
    contamination?: "fail" | "record";
    /** Allow the arm to omit the target, to rehearse an operational failure. */
    allowMissingTarget?: boolean;
}

/** A product-supplied, immutable primary check for one docs case. */
export interface PrimaryCheckSpec {
    /** Stable checker identity recorded with every result. */
    id: string;
    /** Source directory, resolved relative to the suite document. */
    directory: string;
    /** Script inside that directory; the fixed interpreter is `node`. */
    script: string;
    /** Wall-clock bound; defaults to 30000. */
    timeoutMs?: number;
}

/** A case that expects a docs write, or a deliberate refused write. */
export interface DocsTaskCase extends CaseBase {
    /** The kind value. */
    kind: "docs-task";
    /** The expected docs value. */
    expectedDocs: ExpectedDocs;
    /** The criterion value. */
    criterion?: DocsCriterion;
    /** The guardrails value. */
    guardrails?: DocsGuardrails;
    /** Workspace-relative lake root; defaults to `docs`. */
    lakeRoot?: string;
    /** Arm-blind facts the judge may use; never mounted in the trial. */
    truth?: string;
    /** The product's independent primary check, executed after the trial. */
    primaryCheck?: PrimaryCheckSpec;
}

/** One declared judge-recovery registration, validated by the analysis policy. */
export interface RecoveryDeclaration {
    /** The schema version value. */
    version: number;
    /** The eligible failure classes. */
    eligibleFailureClasses: string[];
    /** Whether completion evidence is mandatory. */
    requiresCompletionEvidence: boolean;
    /** Recoveries per failed slot. */
    maxRecoveriesPerSlot: number;
    /** Campaign-wide recovery attempts. */
    recoveryCeiling: number;
    /** Total judge attempts, initial assessments plus recoveries. */
    totalJudgeAttempts: number;
    /** Requests per attempt the adapter exposes, or null when unavailable. */
    providerRequestLimit: number | null;
}

/** One reusable, discriminated case definition. */
export type SuiteCase = SkillTriggerCase | DocsTaskCase;

/** A versioned suite document. */
export interface Suite {
    /** The schema version value. */
    schemaVersion: 1;
    /** The suite id value. */
    suiteId: string;
    /** The description value. */
    description?: string;
    /** The assessment value. */
    assessment: AssessmentKind;
    /** The cases value. */
    cases: SuiteCase[];
}

/** One skill bundle supplied by an arm. */
export interface SkillSubject {
    /** The id value. */
    id: string;
    /** The path value. */
    path: string;
}

/** One plugin package supplied by an arm. */
export interface PluginSubject {
    /** The id value. */
    id: string;
    /** The path value. */
    path: string;
    /** Package-relative members staged for the runtime; defaults apply. */
    include?: string[];
    /** Non-secret plugin options handed to OpenCode. */
    options?: unknown;
}

/** One instruction overlay copied into the trial workspace. */
export interface InstructionSubject {
    /** The id value. */
    id: string;
    /** The path value. */
    path: string;
    /** Workspace-relative destination; defaults to `AGENTS.md`. */
    as?: string;
}

/** One treatment configuration. */
export interface Arm {
    /** The arm id value. */
    armId: string;
    /** The skills value. */
    skills?: SkillSubject[];
    /** The plugins value. */
    plugins?: PluginSubject[];
    /** The instructions value. */
    instructions?: InstructionSubject[];
}

/** One scheduled case × arm × repetition. */
export interface Slot {
    /** The slot id value. */
    slotId: string;
    /** The case id value. */
    caseId: string;
    /** The arm id value. */
    armId: string;
    /** The repetition id value. */
    repetitionId: string;
}

/** The provider route the runtime uses. */
export interface ProviderRoute {
    /** A human-readable route label, e.g. `scripted` or `host-proxy`. */
    route: string;
    /** OpenCode model route (`provider/model`). */
    model: string;
    /** Non-secret provider overlay merged into OPENCODE_CONFIG_CONTENT. */
    overlay?: Record<string, unknown>;
}

/** The pinned execution environment. */
export interface RuntimeSpec {
    /** Image tag or local name used to build/resolve the run image. */
    image: string;
    /** Immutable image identity, required once frozen. */
    imageId?: string;
    /** The OpenCode CLI version the image is expected to contain. */
    opencodeVersion: string;
    /** The provider value. */
    provider: ProviderRoute;
    /** Per-trial wall-clock budget. */
    timeoutMs: number;
    /** `host` shares the host network; it is not provider-only isolation. */
    network: "host" | "none";
    /** Container CLI; podman is the only supported adapter today. */
    containerCli?: "podman";
    /** Extra non-secret environment names passed through, never values. */
    passthroughEnv?: string[];
}

/** Explicit spend ceilings; a campaign never infers them. */
export interface Budgets {
    /** The trials value. */
    trials: number;
    /** The judge attempts value. */
    judgeAttempts: number;
}

/** Assessment configuration, separate from the suite's assessment kind. */
export interface AssessmentSpec {
    /** The kind value. */
    kind: AssessmentKind;
    /** A model judge is optional and never implied by a deterministic suite. */
    judge?: { model: string; timeoutMs?: number };
    /** An explicit recovery registration; absent means no retry. */
    recovery?: RecoveryDeclaration;
}

/** A versioned campaign document. */
export interface Campaign {
    /** The schema version value. */
    schemaVersion: 1;
    /** The campaign id value. */
    campaignId: string;
    /** Suite location, relative to the campaign document. */
    suite: { path: string; sha256?: string };
    /** The subjects value. */
    subjects: Arm[];
    /** The schedule value. */
    schedule: { kind: "explicit"; slots: Slot[] };
    /** The runtime value. */
    runtime: RuntimeSpec;
    /** The budgets value. */
    budgets: Budgets;
    /** The assessment value. */
    assessment: AssessmentSpec;
    /** OpenCode permission configuration; never credentials. */
    permissions?: Record<string, unknown>;
    /** Stop after the first unusable or failed assessment. */
    stopOnFirstFailure?: boolean;
    /**
     * Stop-policy semantics; version 2 adds primary-check, assessment and
     * adverse-verdict stopping. Absent means legacy version 1.
     */
    stopPolicy?: { version: 2 };
}

/** A validated campaign plus its resolved suite. */
export interface CampaignBundle {
    /** The campaign value. */
    campaign: Campaign;
    /** The suite value. */
    suite: Suite;
    /** Absolute path of the campaign document. */
    campaignPath: string;
    /** Absolute path of the resolved suite document. */
    suitePath: string;
    /** The campaign document's declared suite hash, or null when omitted. */
    declaredSuiteSha256: string | null;
}

/** The finite lifecycle states derived from evidence. */
export type LifecycleState =
    "prepared" | "frozen" | "running" | "assessed" | "closed" | "blocked";
