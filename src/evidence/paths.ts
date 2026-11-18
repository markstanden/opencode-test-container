/**
 * Canonical evidence paths and component-aware containment.
 *
 * Every lifecycle module names the same evidence locations; importing them
 * from one dependency-light module keeps the layout in a single place. Path
 * containment is compared by path *components*, never by a string prefix, so
 * a child literally named `..cache` is still a child and `evidence` never
 * matches `evidence-archive`.
 */
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Whether `child` is `parent` itself or sits beneath it.
 * @param parent The container path.
 * @param child The candidate path.
 * @returns True when every relative component stays below `parent`.
 */
export function pathWithin(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    if (rel === "") return true;
    if (isAbsolute(rel)) return false;
    return !rel.split(sep).includes("..");
}

/** The evidence directory for one campaign root. */
export function evidenceRoot(root: string): string {
    return join(root, "evidence");
}

/** The append-only attempt ledger. */
export function ledgerPath(root: string): string {
    return join(root, "evidence", "ATTEMPTS.jsonl");
}

/** The shared admission lock. */
export function admissionLockPath(root: string): string {
    return join(root, "evidence", "ADMISSION.lock");
}

/** The root of per-slot trial evidence. */
export function trialsRoot(root: string): string {
    return join(root, "evidence", "trials");
}

/** One trial's evidence directory. */
export function trialDirectory(root: string, slotId: string): string {
    return join(root, "evidence", "trials", slotId);
}

/** The root of per-slot judge evidence. */
export function judgeRoot(root: string): string {
    return join(root, "evidence", "judgements");
}

/** One slot's judge directory. */
export function judgeDirectory(root: string, slotId: string): string {
    return join(root, "evidence", "judgements", slotId);
}

/** One judge attempt's directory. */
export function judgeAttemptDirectory(
    root: string,
    slotId: string,
    attemptId: string,
): string {
    return join(root, "evidence", "judgements", slotId, attemptId);
}

/** One slot's checked selection record. */
export function selectionPath(root: string, slotId: string): string {
    return join(root, "evidence", "judgements", slotId, "selection.json");
}

/** One slot's registered judge packet. */
export function packetPath(root: string, slotId: string): string {
    return join(root, "evidence", "judgements", slotId, "packet.md");
}

/** One slot's durable assessment record. */
export function assessmentPath(root: string, slotId: string): string {
    return join(root, "evidence", "assessments", `${slotId}.json`);
}

/** The assessment directory. */
export function assessmentsRoot(root: string): string {
    return join(root, "evidence", "assessments");
}

/** The root of durable dispatch claims. */
export function claimsRoot(root: string): string {
    return join(root, "evidence");
}

/** One claim directory for a claim kind. */
export function claimsDirectory(
    root: string,
    kind: "trial" | "judge" | "recovery",
): string {
    return join(root, "evidence", kind);
}
