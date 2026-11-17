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
 * A lock is never deleted by another process. A live holder is waited for and
 * then refused; a stale lock after a hard crash also fails closed until an
 * operator verifies the owner is gone and removes that exact path. This is
 * deliberately conservative: automatic stale recovery has a check-then-unlink
 * race that can admit two owners.
 */
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sleepSync } from "../contracts/sleep.ts";

/** A completed critical section, or the refusal. */
export type AdmissionResult<T> =
    { ok: true; value: T } | { ok: false; problem: string };

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

/** The current admission lock, for diagnostics and controlled recovery. */
export interface AdmissionLockStatus {
    /** The lock path. */
    path: string;
    /** Whether a lock file exists. */
    held: boolean;
    /** The recorded owner pid, when readable. */
    pid: number | null;
}

/**
 * Read the admission lock without touching it.
 * @param root The campaign root.
 * @returns The lock status.
 */
export function admissionLockStatus(root: string): AdmissionLockStatus {
    const path = join(root, "evidence", "ADMISSION.lock");
    return { path, held: existsSync(path), pid: lockPid(path) };
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
            sleepSync(10);
        }
    }
    if (!owned) {
        const pid = lockPid(path);
        return {
            ok: false,
            problem: `admission lock ${path} is held${pid === null ? "" : ` by pid ${pid}`}; verify that process is gone and remove the lock deliberately`,
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
            // Only our own token is removed. A failed release is surfaced by
            // the next holder's refusal, never by deleting someone else's lock.
        }
    }
}
