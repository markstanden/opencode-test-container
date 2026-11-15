import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleState } from "../contracts/types.ts";
import { loadPreparedManifest } from "./prepare.ts";
import { loadFrozen } from "./freeze.ts";
import { readLedger, trialStarts } from "./ledger.ts";
import { readAssessments, assessmentPath } from "./assess.ts";
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
    /** The next actions value. */
    nextActions: NextAction[];
    /** The problems value. */
    problems: string[];
}

/** Derive the finite lifecycle state from checked evidence. */
function lifecycleStateOf(options: {
    root: string;
    manifest: StatusManifest;
    frozen: boolean;
    starts: number;
    closed: boolean;
}): LifecycleState {
    if (options.closed) return "closed";
    const allAssessed =
        options.manifest.campaign.schedule.slots.length > 0 &&
        options.manifest.campaign.schedule.slots.every((slot) =>
            existsSync(assessmentPath(options.root, slot.slotId)),
        );
    if (allAssessed) return "assessed";
    if (options.starts > 0) return "running";
    return options.frozen ? "frozen" : "prepared";
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
    const remaining = options.manifest.campaign.budgets.trials - options.starts;
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
    if (options.starts > 0 && options.completed === options.starts) {
        actions.push({
            command: `otc close --root ${quoted}`,
            reason: "all started trials have ended",
        });
    }
    return actions;
}

/**
 * Observe a campaign root without writing, building, probing or dispatching.
 * Every next action is derived from the manifest and checked evidence.
 * @param root The campaign root.
 * @returns The status document.
 */
export function statusOf(root: string): StatusReport {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) {
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
            budgets: null,
            nextActions: [],
            problems: [prepared.problem],
        };
    }
    const manifest = prepared.manifest;
    const ledger = readLedger(root);
    const problems = ledger.state === "malformed" ? [...ledger.problems] : [];
    const starts = trialStarts(ledger.events);
    const completed = new Set(
        ledger.events
            .filter((event) => event.event === "trial-end")
            .map((event) =>
                typeof event.slotId === "string" ? event.slotId : "",
            ),
    );
    const assessments = readAssessments(root);
    const frozen = loadFrozen(root);
    if (!frozen.ok) problems.push(frozen.problem);
    const state = lifecycleStateOf({
        root,
        manifest,
        frozen: frozen.ok,
        starts: starts.length,
        closed: ledger.state === "closed",
    });
    const nextActions = nextActionsOf({
        root,
        manifest,
        frozen: frozen.ok,
        closed: ledger.state === "closed",
        starts: starts.length,
        completed: completed.size,
        assessments: assessments.length,
    });
    return {
        schemaVersion: 1,
        state,
        campaignId: manifest.campaignId,
        suiteId: manifest.suiteId,
        root,
        imageId: frozen.ok ? frozen.record.imageId : null,
        frozenAt: frozen.ok ? frozen.record.frozenAt : null,
        closedAt: ledger.closedAt,
        counts: {
            slots: manifest.campaign.schedule.slots.length,
            started: starts.length,
            completed: completed.size,
            assessed: assessments.length,
            pass: assessments.filter((entry) => entry.outcome === "pass")
                .length,
            fail: assessments.filter((entry) => entry.outcome === "fail")
                .length,
            unknown: assessments.filter((entry) => entry.outcome === "unknown")
                .length,
        },
        budgets: {
            trials: manifest.campaign.budgets.trials,
            used: starts.length,
            remaining: manifest.campaign.budgets.trials - starts.length,
        },
        nextActions,
        problems,
    };
}

/** Status for a slot's trial directory, used by reports and diagnostics. */
export function slotTrialExists(root: string, slotId: string): boolean {
    return existsSync(trialDirectory(root, slotId));
}
