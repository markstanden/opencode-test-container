/**
 * The shared admission/closure protocol.
 *
 * Dispatch admission and campaign closure both take one exclusive lock under
 * `<root>/evidence/ADMISSION.lock` for the short window in which they decide
 * and publish: admission re-reads the ledger and creates its durable claim;
 * closure re-reads the ledger and claims and appends the close event. Whichever
 * wins, the other observes its result. The lock is never held across a running
 * container.
 *
 * A crashed holder is recoverable only when its recorded process is gone and
 * the lock is old; a live holder is waited for, then refused. A lock is never
 * deleted merely because it is old.
 */
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sleepSync } from "../contracts/sleep.ts";

/** A completed critical section, or the refusal. */
export type AdmissionResult<T> =
    { ok: true; value: T } | { ok: false; problem: string };

/** Whether a recorded pid still exists. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Read one lock's pid, or null when unusable. */
function lockPid(path: string): number | null {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return typeof value === "object" &&
            value !== null &&
            "pid" in value &&
            typeof value.pid === "number"
            ? value.pid
            : null;
    } catch {
        return null;
    }
}

/** Remove a lock only when its owner is provably gone and it is not fresh. */
function recoverStale(path: string): boolean {
    const pid = lockPid(path);
    if (pid === null || alive(pid)) return false;
    try {
        if (Date.now() - statSync(path).mtimeMs < 1_000) return false;
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Run one critical section under the campaign admission lock.
 * @param root The campaign root.
 * @param section The short decision/publication body.
 * @returns The body's value, or the lock refusal.
 */
export function withAdmission<T>(
    root: string,
    section: () => T,
): AdmissionResult<T> {
    const directory = join(root, "evidence");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "ADMISSION.lock");
    const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
    let owned = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
            const fd = openSync(path, "wx", 0o600);
            try {
                writeFileSync(
                    fd,
                    `${JSON.stringify({ pid: process.pid, token })}\n`,
                );
            } finally {
                closeSync(fd);
            }
            owned = true;
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                return {
                    ok: false,
                    problem: `admission lock failed: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
            if (recoverStale(path)) continue;
            sleepSync(10);
        }
    }
    if (!owned) {
        return {
            ok: false,
            problem: "admission is held by another process; retry shortly",
        };
    }
    try {
        return { ok: true, value: section() };
    } finally {
        try {
            if (
                existsSync(path) &&
                readFileSync(path, "utf8").includes(token)
            ) {
                unlinkSync(path);
            }
        } catch {
            // The lock is advisory; a failed release is surfaced by the next
            // holder's stale check, never by deleting someone else's lock.
        }
    }
}
