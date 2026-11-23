import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleState } from "../contracts/types.ts";
import { loadPreparedManifest } from "./prepare.ts";
import { deliveryCheck, loadFrozen } from "./freeze.ts";
import { readLedger, trialStarts } from "./ledger.ts";
import { judgeStateOf } from "./eligibility.ts";
import { checkedAssessments } from "../evidence/assessments.ts";
import { admissionLockStatus } from "./admission.ts";
import {
    checkedSelection,
    packetIntegrityProblems,
    policyOf,
    readJudgeAttempts,
    selectionPath as selectionPathOf,
} from "./judge.ts";
import {
    toolIdentity,
    toolIdentityProblems,
    type ToolIdentity,
} from "../contracts/version.ts";
import { readClaims, type BudgetClaim, type BudgetKind } from "./budget.ts";
import { trialDirectory } from "./run.ts";
import type { PreparedManifest } from "./prepare.ts";

/** The manifest shape status reads. */
type StatusManifest = PreparedManifest;

/** A suggested next command, derived from checked state. */
export interface NextAction {
    /** The command value. */
    command: string;
    /** The reason value. */
    reason: string;
}

/** The read-only status document. */
export interface StatusReport {
    /** The schema version value. */
    schemaVersion: 1;
    /** The state value. */
    state: LifecycleState;
    /** The campaign id value. */
    campaignId: string | null;
    /** The suite id value. */
    suiteId: string | null;
    /** The root value. */
    root: string;
    /** The image id value. */
    imageId: string | null;
    /** The frozen at value. */
    frozenAt: string | null;
    /** The closed at value. */
    closedAt: string | null;
    /** The counts value. */
    counts: {
        slots: number;
        started: number;
        completed: number;
        assessed: number;
        pass: number;
        fail: number;
        unknown: number;
    };
    /** The budgets value. */
    budgets: { trials: number; used: number; remaining: number } | null;
    /** The executing tool identity. */
    tool: ToolIdentity | null;
    /** The judgement counts value. */
    judgement: {
        /** Slots with a checked selection. */
        judged: number;
        /** Completed slots still awaiting a usable judgement. */
        pending: number;
        /** Completed slots whose attempts ended without a usable verdict. */
        failed: number;
        /** Every recorded judge attempt. */
        attempts: number;
        /** Attempts that ended without a usable verdict. */
        invalid: number;
        /** Durable judge and recovery claims not yet closed. */
        unsettled: number;
        /** Packet and selection integrity diagnostics. */
        problems: string[];
    } | null;
    /** The next actions value. */
    nextActions: NextAction[];
    /** The problems value. */
    problems: string[];
}

/** Derive the finite lifecycle state from checked evidence. */
function lifecycleStateOf(options: {
    manifest: StatusManifest;
    frozen: boolean;
    starts: number;
    closed: boolean;
    allAssessed: boolean;
    blocked: boolean;
}): LifecycleState {
    if (options.blocked) return "blocked";
    if (options.closed) return "closed";
    if (options.allAssessed) return "assessed";
    if (options.starts > 0) return "running";
    return options.frozen ? "frozen" : "prepared";
}

/** One slot's shared eligibility decision and attempt counts. */
function slotJudgement(options: {
    root: string;
    manifest: StatusManifest;
    slot: StatusManifest["campaign"]["schedule"]["slots"][number];
    policy: ReturnType<typeof policyOf>;
    assessment:
        ReturnType<typeof checkedAssessments>["records"][number] | undefined;
}): {
    state: ReturnType<typeof judgeStateOf>;
    attempts: number;
    invalid: number;
} {
    const recorded = readJudgeAttempts(options.root, options.slot.slotId);
    const selection = options.policy.ok
        ? checkedSelection({
              root: options.root,
              manifest: options.manifest,
              slot: options.slot,
              policy: options.policy.policy,
          })
        : { ok: false as const, problems: options.policy.problems };
    const state = judgeStateOf({
        manifest: options.manifest,
        slot: options.slot,
        trialRecorded: existsSync(
            join(
                trialDirectory(options.root, options.slot.slotId),
                "meta.json",
            ),
        ),
        assessment: options.assessment,
        selectionPresent: existsSync(
            selectionPathOf(options.root, options.slot.slotId),
        ),
        selection: selection.ok
            ? { ok: true, problems: [] }
            : { ok: false, problems: selection.problems },
        attempts: recorded,
    });
    return {
        state,
        attempts: recorded.length,
        invalid: recorded.filter(
            (attempt) =>
                attempt.judgementStatus === "invalid-verdict" ||
                attempt.judgementStatus === "judge-error",
        ).length,
    };
}

/** Fold one slot's state into the report's judgement counts. */
function countJudgement(
    counts: {
        judged: number;
        pending: number;
        failed: number;
        problems: string[];
    },
    slotId: string,
    state: ReturnType<typeof judgeStateOf>,
): void {
    if (state.code === "judged") counts.judged += 1;
    else if (state.code === "terminal-failures") counts.failed += 1;
    else if (state.code === "pending") counts.pending += 1;
    else if (
        state.code === "selection-conflict" ||
        state.code === "selection-missing" ||
        state.code === "unsettled"
    ) {
        counts.problems.push(`${slotId}: ${state.reason}`);
    }
}

/** The judgement counts for every scheduled slot. */
function judgementOf(
    root: string,
    manifest: StatusManifest,
    ledger: ReturnType<typeof readLedger>,
    assessments: ReturnType<typeof checkedAssessments>["records"],
    trialClaims: readonly BudgetClaim[],
    claimsOf: (root: string, kind: BudgetKind) => BudgetClaim[],
): StatusReport["judgement"] {
    if (manifest.campaign.assessment.judge === undefined) return null;
    const policy = policyOf(manifest);
    const bySlot = new Map(assessments.map((entry) => [entry.slotId, entry]));
    const counts = {
        judged: 0,
        pending: 0,
        failed: 0,
        problems: [] as string[],
    };
    let attempts = 0;
    let invalid = 0;
    for (const slot of manifest.campaign.schedule.slots) {
        const one = slotJudgement({
            root,
            manifest,
            slot,
            policy,
            assessment: bySlot.get(slot.slotId),
        });
        attempts += one.attempts;
        invalid += one.invalid;
        countJudgement(counts, slot.slotId, one.state);
    }
    const unsettled = ["trial", "judge", "recovery"].reduce(
        (sum, kind) =>
            sum +
            (kind === "trial"
                ? trialClaims
                : claimsOf(join(root, "evidence"), kind as "judge" | "recovery")
            ).filter((claim) => claim.state !== "closed").length,
        0,
    );
    counts.problems.push(
        ...manifest.campaign.schedule.slots.flatMap((slot) =>
            packetIntegrityProblems(root, manifest, slot).map(
                (problem) => `${slot.slotId}: ${problem}`,
            ),
        ),
    );
    return {
        judged: counts.judged,
        pending: counts.pending,
        failed: counts.failed,
        attempts,
        invalid,
        unsettled,
        problems: counts.problems,
    };
}

/** The judge action when completed slots are awaiting a checked judgement. */
function judgeAction(
    root: string,
    judgement: StatusReport["judgement"],
): NextAction[] {
    return judgement !== null && judgement.pending > 0
        ? [
              {
                  command: `otc judge --root ${JSON.stringify(root)}`,
                  reason: `${judgement.pending} completed slot(s) have no checked judgement`,
              },
          ]
        : [];
}

/** Build the actionable next commands from state, never from constants. */
function nextActionsOf(options: {
    root: string;
    manifest: StatusManifest;
    frozen: boolean;
    closed: boolean;
    starts: number;
    completed: number;
    assessments: number;
    /** Trial claims observed for this same status response. */
    used: number;
    judgement: StatusReport["judgement"];
}): NextAction[] {
    const quoted = JSON.stringify(options.root);
    if (!options.frozen) {
        return [
            {
                command: `otc freeze --root ${quoted}`,
                reason: "the prepared payload is not frozen",
            },
        ];
    }
    if (options.closed) {
        return [
            {
                command: `otc analyse --root ${quoted} --out ${JSON.stringify(join(options.root, "reports", "final"))}`,
                reason: "the campaign is closed; render final analysis",
            },
        ];
    }
    const slots = options.manifest.campaign.schedule.slots;
    const remaining = options.manifest.campaign.budgets.trials - options.used;
    const unstarted = slots.length - options.starts;
    const actions: NextAction[] = [];
    if (unstarted > 0 && remaining > 0) {
        actions.push({
            command: `otc run --root ${quoted}`,
            reason: `${unstarted} slot(s) unstarted, ${remaining} trial(s) budgeted`,
        });
    } else if (unstarted === 0 && options.assessments < slots.length) {
        actions.push({
            command: `otc assess --root ${quoted}`,
            reason: "every started slot has evidence; deterministic assessment is pending",
        });
    }
    actions.push(...judgeAction(options.root, options.judgement));
    if (options.starts > 0 && options.completed === options.starts) {
        actions.push({
            command: `otc close --root ${quoted}`,
            reason: "all started trials have ended",
        });
    }
    return actions;
}

/** Governance diagnostics: admission, policy and judgement state. */
function governanceProblems(
    root: string,
    manifest: StatusManifest,
    judgement: StatusReport["judgement"],
): string[] {
    const lock = admissionLockStatus(root);
    const policy = policyOf(manifest);
    const pidNote = lock.pid === null ? "" : ` by pid ${lock.pid}`;
    return [
        ...(lock.held
            ? [
                  `admission lock ${lock.path} is held${pidNote}; verify that process is gone before removing it`,
              ]
            : []),
        ...(policy.ok ? [] : policy.problems),
        ...(judgement?.problems ?? []),
    ];
}

/** Whether an integrity problem makes the campaign unavailable for action. */
function integrityBlocked(options: {
    ledger: ReturnType<typeof readLedger>;
    recordProblems: readonly string[];
    delivery: readonly string[];
}): boolean {
    return (
        options.ledger.state === "malformed" ||
        options.recordProblems.length > 0 ||
        options.delivery.length > 0
    );
}

/**
 * Observe a campaign root without writing, building, probing or dispatching.
 * Every next action is derived from the manifest and checked evidence.
 * @param root The campaign root.
 * @returns The status document.
 */
/** The empty blocked document for a root that cannot be read. */
function blockedDocument(root: string, problems: string[]): StatusReport {
    return {
        schemaVersion: 1,
        state: "blocked",
        campaignId: null,
        suiteId: null,
        root,
        imageId: null,
        frozenAt: null,
        closedAt: null,
        counts: {
            slots: 0,
            started: 0,
            completed: 0,
            assessed: 0,
            pass: 0,
            fail: 0,
            unknown: 0,
        },
        tool: null,
        budgets: null,
        judgement: null,
        nextActions: [],
        problems,
    };
}

/** One campaign's checked assessment view. */
interface AssessmentView {
    records: ReturnType<typeof checkedAssessments>["records"];
    valid: NonNullable<
        ReturnType<typeof checkedAssessments>["records"][number]["record"]
    >[];
    problems: string[];
    recordProblems: string[];
}

/** Check assessments and report completed slots without one. */
function assessmentView(
    root: string,
    manifest: StatusManifest,
    ledger: ReturnType<typeof readLedger>,
): AssessmentView {
    const checked = checkedAssessments({ root, manifest, ledger });
    const valid = checked.records.flatMap((entry) =>
        entry.state === "valid" && entry.record !== null ? [entry.record] : [],
    );
    const validSlots = new Set(
        checked.records
            .filter((entry) => entry.state === "valid")
            .map((entry) => entry.slotId),
    );
    const missing = ledger.events
        .filter((event) => event.event === "trial-end")
        .flatMap((event) =>
            typeof event.slotId === "string" &&
            event.slotId !== "" &&
            !validSlots.has(event.slotId)
                ? [`completed slot ${event.slotId} has no checked assessment`]
                : [],
        );
    return {
        records: checked.records,
        valid,
        problems: [...checked.problems, ...missing],
        recordProblems: checked.problems,
    };
}

/** The frozen receipt, delivery drift and executing tool identity. */
function frozenView(root: string): {
    frozen: ReturnType<typeof loadFrozen>;
    delivery: string[];
    problems: string[];
    tool: ReturnType<typeof toolIdentity>;
} {
    const frozen = loadFrozen(root);
    if (!frozen.ok) {
        return {
            frozen,
            delivery: [],
            problems: [frozen.problem],
            tool: toolIdentity(),
        };
    }
    const tool = toolIdentity();
    const delivery = deliveryCheck(root).filter(
        (problem) =>
            !problem.startsWith("frozen tool") &&
            !problem.includes("executing"),
    );
    return {
        frozen,
        delivery,
        problems: [
            ...delivery,
            ...toolIdentityProblems(frozen.record.tool, tool),
        ],
        tool,
    };
}

/** The report's counts, derived only from checked valid assessments. */
function countsOf(
    manifest: StatusManifest,
    starts: number,
    completed: number,
    valid: AssessmentView["valid"],
): StatusReport["counts"] {
    return {
        slots: manifest.campaign.schedule.slots.length,
        started: starts,
        completed,
        assessed: valid.length,
        pass: valid.filter((entry) => entry.outcome === "pass").length,
        fail: valid.filter((entry) => entry.outcome === "fail").length,
        unknown: valid.filter((entry) => entry.outcome === "unknown").length,
    };
}

/**
 * Observe a campaign root without writing, building, probing or dispatching.
 * Every next action is derived from the manifest and checked evidence observed
 * for this one response.
 * @param root The campaign root.
 * @param deps Claim reader, injected by consistency tests.
 * @param deps.claims Reads the claims of one kind for this response.
 * @returns The status document.
 */
export function statusOf(
    root: string,
    deps: {
        claims?: (root: string, kind: BudgetKind) => BudgetClaim[];
    } = {},
): StatusReport {
    const claimsOf = deps.claims ?? readClaims;
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return blockedDocument(root, [prepared.problem]);
    const manifest = prepared.manifest;
    const ledger = readLedger(root);
    const starts = trialStarts(ledger.events);
    const completed = new Set(
        ledger.events
            .filter((event) => event.event === "trial-end")
            .flatMap((event) =>
                typeof event.slotId === "string" ? [event.slotId] : [],
            ),
    );
    const assessments = assessmentView(root, manifest, ledger);
    const frozen = frozenView(root);
    const trialClaims = claimsOf(join(root, "evidence"), "trial");
    const judgement = judgementOf(
        root,
        manifest,
        ledger,
        assessments.records,
        trialClaims,
        claimsOf,
    );
    const problems = [
        ...(ledger.state === "malformed" ? ledger.problems : []),
        ...assessments.problems,
        ...frozen.problems,
        ...governanceProblems(root, manifest, judgement),
    ];
    const blocked = integrityBlocked({
        ledger,
        recordProblems: assessments.recordProblems,
        delivery: frozen.delivery,
    });
    const state = lifecycleStateOf({
        manifest,
        frozen: frozen.frozen.ok,
        starts: starts.length,
        closed: ledger.state === "closed",
        allAssessed: assessments.records.every(
            (entry) => entry.state === "valid",
        ),
        blocked,
    });
    const used = trialClaims.length;
    return {
        schemaVersion: 1,
        state,
        campaignId: manifest.campaignId,
        suiteId: manifest.suiteId,
        root,
        imageId: frozen.frozen.ok ? frozen.frozen.record.imageId : null,
        frozenAt: frozen.frozen.ok ? frozen.frozen.record.frozenAt : null,
        closedAt: ledger.closedAt,
        counts: countsOf(
            manifest,
            starts.length,
            completed.size,
            assessments.valid,
        ),
        tool: frozen.tool,
        budgets: {
            trials: manifest.campaign.budgets.trials,
            used,
            remaining: manifest.campaign.budgets.trials - used,
        },
        judgement,
        nextActions: blocked
            ? []
            : nextActionsOf({
                  root,
                  manifest,
                  frozen: frozen.frozen.ok,
                  closed: ledger.state === "closed",
                  starts: starts.length,
                  completed: completed.size,
                  assessments: assessments.valid.length,
                  used,
                  judgement,
              }),
        problems,
    };
}

/** Status for a slot's trial directory, used by reports and diagnostics. */
export function slotTrialExists(root: string, slotId: string): boolean {
    return existsSync(trialDirectory(root, slotId));
}
