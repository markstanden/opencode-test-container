/**
 * Pure primary-check record calculation.
 *
 * Execution, script inspection and publication stay in `primary.ts`; this
 * module only turns observed facts and elapsed time into the record.
 */
import type { PrimaryCheckRecord } from "./primary.ts";

/** The fixed facts a primary-check record is calculated from. */
export type PrimaryRecordFacts = Pick<
    PrimaryCheckRecord,
    | "schemaVersion"
    | "id"
    | "script"
    | "sourceHash"
    | "command"
    | "args"
    | "timeoutMs"
    | "startedAt"
>;

/** The mutable outcome facts a primary-check record is calculated from. */
export type PrimaryRecordOutcome = Pick<
    PrimaryCheckRecord,
    "status" | "exit" | "signal" | "reason" | "stdout" | "stderr"
>;

/**
 * Calculate one primary-check record from observed inputs and the elapsed time.
 * @param facts The fixed checker identity and start time.
 * @param elapsedMs The observed duration.
 * @param outcome The process outcome.
 * @returns The complete record.
 */
export function primaryRecordFor(
    facts: PrimaryRecordFacts,
    elapsedMs: number,
    outcome: PrimaryRecordOutcome,
): PrimaryCheckRecord {
    return {
        ...facts,
        durationMs: elapsedMs,
        ...outcome,
        stdout: outcome.stdout.slice(0, 16_000),
        stderr: outcome.stderr.slice(0, 16_000),
    };
}
