import { appendLedgerEvent, readLedger, trialStarts } from "./ledger.ts";
import { loadPreparedManifest, type PreparedManifest } from "./prepare.ts";
import { loadFrozen } from "./freeze.ts";
import { readAssessments } from "./assess.ts";
import {
    checkedSelection,
    packetIntegrityProblems,
    policyOf,
    readJudgeAttempts,
} from "./judge.ts";
import { readClaims } from "../evaluators/docs/analysis/budget.ts";
import { join } from "node:path";

/** Unsettled spend claims that must stop closure, or an empty list. */
function unsettledClaims(root: string): string[] {
    return ["judge", "recovery"].flatMap((kind) =>
        readClaims(join(root, "evidence"), kind as "judge" | "recovery")
            .filter((claim) => claim.state !== "closed")
            .map(
                (claim) =>
                    `${kind} claim ${claim.index} is ${claim.state}${claim.stamp === null ? "" : ` for ${claim.stamp}`}`,
            ),
    );
}

/** Completed slots with neither a selected judgement nor a terminal failure. */
function unjudgedCompleted(
    root: string,
    manifest: PreparedManifest,
    completed: ReadonlySet<string>,
): string[] {
    if (manifest.campaign.assessment.judge === undefined) return [];
    const policy = policyOf(manifest);
    return manifest.campaign.schedule.slots.flatMap((slot) => {
        if (!completed.has(slot.slotId)) return [];
        const checked = policy.ok
            ? checkedSelection({
                  root,
                  manifest,
                  slot,
                  policy: policy.policy,
              })
            : { ok: false as const, problems: policy.problems };
        if (checked.ok) return [];
        const terminal = readJudgeAttempts(root, slot.slotId).some(
            (attempt) =>
                attempt.judgementStatus === "invalid-verdict" ||
                attempt.judgementStatus === "judge-error",
        );
        return terminal ? [] : [slot.slotId];
    });
}

/** The closure outcome. */
export type CloseResult =
    | { ok: true; alreadyClosed: boolean; closedAt: string }
    | { ok: false; problems: string[] };

/** Every reason closure must refuse now, in reporting order. */
function closureRefusals(
    root: string,
    manifest: PreparedManifest,
    starts: ReturnType<typeof trialStarts>,
    ended: ReadonlySet<string>,
): string[] {
    const unresolved = starts
        .map((event) => (typeof event.slotId === "string" ? event.slotId : ""))
        .filter((slotId) => !ended.has(slotId));
    if (unresolved.length > 0) {
        return [
            `unresolved trial launch(es): ${unresolved.join(", ")}; closure would hide unknown spend`,
        ];
    }
    const packetProblems = manifest.campaign.schedule.slots.flatMap((slot) =>
        packetIntegrityProblems(root, manifest, slot).map(
            (problem) => `${slot.slotId}: ${problem}`,
        ),
    );
    if (packetProblems.length > 0) {
        return ["judge packet integrity failed", ...packetProblems];
    }
    const claims = unsettledClaims(root);
    if (claims.length > 0) {
        return [
            `unsettled judge spend: ${claims.join("; ")}; closure would hide an unknown outcome`,
        ];
    }
    const policy = policyOf(manifest);
    if (!policy.ok) return policy.problems;
    const pending = unjudgedCompleted(root, manifest, ended);
    return pending.length > 0
        ? [
              `unjudged completed slot(s): ${pending.join(", ")}; run otc judge before closure`,
          ]
        : [];
}

/**
 * Close a campaign's ledger. Closure is an append-only event and is
 * idempotent; a malformed ledger or an unresolved launch refusal prevents it.
 * @param root The campaign root.
 * @param now Injected clock for tests.
 * @returns The closure outcome.
 */
export function closeCampaign(
    root: string,
    now: () => string = () => new Date().toISOString(),
): CloseResult {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const frozen = loadFrozen(root);
    if (!frozen.ok) return { ok: false, problems: [frozen.problem] };
    const ledger = readLedger(root);
    if (ledger.state === "malformed") {
        return { ok: false, problems: ledger.problems };
    }
    if (ledger.state === "closed") {
        return {
            ok: true,
            alreadyClosed: true,
            closedAt: ledger.closedAt ?? "unknown",
        };
    }
    const starts = trialStarts(ledger.events);
    const ended = new Set(
        ledger.events
            .filter((event) => event.event === "trial-end")
            .map((event) =>
                typeof event.slotId === "string" ? event.slotId : "",
            ),
    );
    const refusals = closureRefusals(root, prepared.manifest, starts, ended);
    if (refusals.length > 0) {
        return { ok: false, problems: refusals };
    }
    const assessments = readAssessments(root);
    const closedAt = now();
    appendLedgerEvent(
        root,
        {
            event: "close",
            campaignId: prepared.manifest.campaignId,
            closedAt,
            trialStarts: starts.length,
            trialEnds: ended.size,
            assessments: assessments.length,
            slots: prepared.manifest.campaign.schedule.slots.length,
        },
        closedAt,
    );
    return { ok: true, alreadyClosed: false, closedAt };
}
