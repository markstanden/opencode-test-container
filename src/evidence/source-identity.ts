/**
 * The exact trial artifacts one assessment consumed.
 *
 * An assessment that names its source bytes can be rechecked later: a changed
 * capture, metadata, answer, primary-check record, docs journal, journal key or
 * evaluated workspace is a conflicting assessment, not a quietly newer result.
 * Hashes are of raw files; the workspace is a sorted path/kind/link/content
 * identity so a retargeted link differs even when its bytes match.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Of } from "../contracts/canonical.ts";
import { inventory } from "../campaign/inventory.ts";

/** Hashes of the trial evidence an assessment is bound to. */
export interface SourceIdentity {
    /** SHA-256 of `events.jsonl`, or null when absent. */
    captureSha256: string | null;
    /** SHA-256 of `meta.json`, or null when absent. */
    metaSha256: string | null;
    /** SHA-256 of `tools.jsonl`, or null when absent. */
    toolsSha256: string | null;
    /** SHA-256 of `answer.md`, or null when absent. */
    answerSha256: string | null;
    /** SHA-256 of `primary-check.json`, or null when absent. */
    primarySha256: string | null;
    /** SHA-256 of the signed docs journal, or null when absent. */
    journalSha256: string | null;
    /** SHA-256 of the per-run journal key, or null when absent. */
    journalKeySha256: string | null;
    /** Sorted workspace identity, or null when absent or unsafe. */
    workspaceSha256: string | null;
    /** Whether the evaluated workspace was safe to inventory. */
    workspaceSafe: boolean;
}

/** Hash one file's bytes, or null when it is absent. */
function hashFile(path: string): string | null {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The workspace identity: path, kind, link target and content bytes. */
function workspaceIdentity(workspace: string): {
    sha256: string | null;
    safe: boolean;
} {
    if (!existsSync(workspace)) return { sha256: null, safe: false };
    const observed = inventory(workspace);
    return observed.ok
        ? { sha256: sha256Of(observed.entries), safe: true }
        : { sha256: null, safe: false };
}

/**
 * Read the source identity of one trial directory.
 * @param trialDir The trial evidence directory.
 * @returns The artifact hashes; absent files are null.
 */
export function sourceIdentity(trialDir: string): SourceIdentity {
    const workspace = workspaceIdentity(join(trialDir, "workspace"));
    return {
        captureSha256: hashFile(join(trialDir, "events.jsonl")),
        metaSha256: hashFile(join(trialDir, "meta.json")),
        toolsSha256: hashFile(join(trialDir, "tools.jsonl")),
        answerSha256: hashFile(join(trialDir, "answer.md")),
        primarySha256: hashFile(join(trialDir, "primary-check.json")),
        journalSha256: hashFile(
            join(trialDir, "journal", "docs-operations.jsonl"),
        ),
        journalKeySha256: hashFile(join(trialDir, "journal-key.txt")),
        workspaceSha256: workspace.sha256,
        workspaceSafe: workspace.safe,
    };
}

/**
 * Name every artifact whose recorded identity no longer holds.
 * @param trialDir The trial evidence directory.
 * @param recorded The identity the assessment recorded.
 * @returns Changed artifact names; empty means the evidence is unchanged.
 */
export function sourceIdentityProblems(
    trialDir: string,
    recorded: SourceIdentity,
): string[] {
    const observed = sourceIdentity(trialDir);
    return (Object.keys(observed) as Array<keyof SourceIdentity>).flatMap(
        (field) =>
            observed[field] === recorded[field]
                ? []
                : [`source evidence ${field} changed after assessment`],
    );
}
