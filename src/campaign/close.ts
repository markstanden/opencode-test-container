import { appendLedgerEvent, readLedger, trialStarts } from "./ledger.ts";
import { loadPreparedManifest } from "./prepare.ts";
import { loadFrozen } from "./freeze.ts";
import { readAssessments } from "./assess.ts";

/** The closure outcome. */
export type CloseResult =
    | { ok: true; alreadyClosed: boolean; closedAt: string }
    | { ok: false; problems: string[] };

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
    const unresolved = starts
        .map((event) => (typeof event.slotId === "string" ? event.slotId : ""))
        .filter((slotId) => !ended.has(slotId));
    if (unresolved.length > 0) {
        return {
            ok: false,
            problems: [
                `unresolved trial launch(es): ${unresolved.join(", ")}; closure would hide unknown spend`,
            ],
        };
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
