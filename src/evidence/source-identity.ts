/**
 * The exact trial artifacts one assessment consumed.
 *
 * An assessment that names its source bytes can be rechecked later: a changed
 * capture, metadata or answer is a conflicting assessment, not a quietly newer
 * result. Hashes are of the raw files, so formatting changes are visible.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
}

/** Hash one file's bytes, or null when it is absent. */
function hashFile(path: string): string | null {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Read the source identity of one trial directory.
 * @param trialDir The trial evidence directory.
 * @returns The four artifact hashes; absent files are null.
 */
export function sourceIdentity(trialDir: string): SourceIdentity {
    return {
        captureSha256: hashFile(join(trialDir, "events.jsonl")),
        metaSha256: hashFile(join(trialDir, "meta.json")),
        toolsSha256: hashFile(join(trialDir, "tools.jsonl")),
        answerSha256: hashFile(join(trialDir, "answer.md")),
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
