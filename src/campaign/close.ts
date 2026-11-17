import { appendLedgerEvent, readLedger, trialStarts } from "./ledger.ts";
import { loadPreparedManifest, type PreparedManifest } from "./prepare.ts";
import { deliveryCheck, loadFrozen } from "./freeze.ts";
import { checkedAssessments } from "../evidence/assessments.ts";
import {
    checkedSelection,
    packetIntegrityProblems,
    policyOf,
    readJudgeAttempts,
} from "./judge.ts";
import { readClaims } from "./budget.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withAdmission } from "./admission.ts";

/** Unsettled spend claims that must stop closure, or an empty list. */
function unsettledClaims(root: string): string[] {
    return ["trial", "judge", "recovery"].flatMap((kind) =>
        readClaims(
            join(root, "evidence"),
            kind as "trial" | "judge" | "recovery",
        )
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
    ledger: ReturnType<typeof readLedger>,
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
    const claims = unsettledClaims(root);
    if (claims.length > 0) {
        return [
            `unsettled spend: ${claims.join("; ")}; closure would hide an unknown outcome`,
        ];
    }
    const assessments = checkedAssessments({ root, manifest, ledger });
    if (assessments.problems.length > 0) {
        return [
            "assessment evidence is not trustworthy",
            ...assessments.problems,
        ];
    }
    const assessed = new Set(
        assessments.records
            .filter((entry) => entry.state === "valid")
            .map((entry) => entry.slotId),
    );
    const missing = [...ended].filter((slotId) => !assessed.has(slotId));
    if (missing.length > 0) {
        return [
            `completed slot(s) have no checked assessment: ${missing.join(", ")}; assess before closure`,
        ];
    }
    const orphanDirectories = manifest.campaign.schedule.slots
        .filter((slot) =>
            existsSync(join(root, "evidence", "trials", slot.slotId)),
        )
        .filter((slot) => !ended.has(slot.slotId))
        .map((slot) => slot.slotId);
    if (orphanDirectories.length > 0) {
        return [
            `trial director(ies) without a terminal record: ${orphanDirectories.join(", ")}; closure would hide unknown spend`,
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
    const admitted = withAdmission(root, () => {
        const ledger = readLedger(root);
        if (ledger.state === "malformed") {
            return { kind: "malformed" as const, problems: ledger.problems };
        }
        if (ledger.state === "closed") {
            return {
                kind: "already" as const,
                closedAt: ledger.closedAt ?? "unknown",
            };
        }
        const drift = deliveryCheck(root);
        if (drift.length > 0) {
            return {
                kind: "refuse" as const,
                problems: ["delivery check failed", ...drift],
            };
        }
        const starts = trialStarts(ledger.events);
        const ended = new Set(
            ledger.events
                .filter((event) => event.event === "trial-end")
                .flatMap((event) =>
                    typeof event.slotId === "string" ? [event.slotId] : [],
                ),
        );
        const refusals = closureRefusals(
            root,
            prepared.manifest,
            ledger,
            starts,
            ended,
        );
        if (refusals.length > 0) {
            return { kind: "refuse" as const, problems: refusals };
        }
        const assessments = checkedAssessments({
            root,
            manifest: prepared.manifest,
            ledger,
        });
        const closedAt = now();
        appendLedgerEvent(
            root,
            {
                event: "close",
                campaignId: prepared.manifest.campaignId,
                closedAt,
                trialStarts: starts.length,
                trialEnds: ended.size,
                assessments: assessments.records.filter(
                    (entry) => entry.state === "valid",
                ).length,
                slots: prepared.manifest.campaign.schedule.slots.length,
            },
            closedAt,
        );
        return { kind: "closed" as const, closedAt };
    });
    if (!admitted.ok) return { ok: false, problems: [admitted.problem] };
    if (admitted.value.kind === "malformed") {
        return { ok: false, problems: admitted.value.problems };
    }
    if (admitted.value.kind === "refuse") {
        return { ok: false, problems: admitted.value.problems };
    }
    return admitted.value.kind === "already"
        ? {
              ok: true,
              alreadyClosed: true,
              closedAt: admitted.value.closedAt,
          }
        : { ok: true, alreadyClosed: false, closedAt: admitted.value.closedAt };
}
