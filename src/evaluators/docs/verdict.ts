/**
 * The docs judge verdict policy.
 *
 * One judge process is classified here: transport or process failure, empty or
 * truncated answer, a complete but malformed answer, a semantic contradiction
 * with the recorded mutation, or a usable verdict. The campaign layer owns
 * when an attempt is dispatched; this module owns what its answer means.
 */
import { decodeTrail, type Usage } from "../../adapters/opencode/events.ts";
import type { CommandResult } from "../../adapters/process.ts";
import {
    judgeFailureClass,
    parseAcJudgement,
    validateAcJudgement,
    type DocState,
    type JudgeFailureClass,
} from "./scoring.ts";

/** The terminal state of one judge attempt. */
export type JudgeAttemptStatus = "judged" | "invalid-verdict" | "judge-error";

/** The outcome of one judge dispatch, before storage. */
export interface AttemptOutcome {
    /** The terminal status. */
    status: JudgeAttemptStatus;
    /** The failure class, null for a usable verdict. */
    failureClass: JudgeFailureClass | null;
    /** Whether the captured answer was complete. */
    complete: boolean;
    /** Capture problems the stream itself showed. */
    captureProblems: string[];
    /** The parsed verdict, when one was readable. */
    judgement: Record<string, unknown> | null;
    /** Validation problems. */
    problems: string[];
    /** Usage the judge stream reported. */
    usage: Usage;
}

/** The capture problems a judge stream shows. */
function judgeCapture(trail: ReturnType<typeof decodeTrail>): string[] {
    const problems: string[] = [];
    if (trail.events === 0) problems.push("the judge emitted no events");
    if (trail.parseFailures > 0) {
        problems.push(
            `${trail.parseFailures} judge event line(s) were not readable JSON`,
        );
    }
    if (trail.textParts === 0) {
        problems.push("the judge emitted no answer text");
    }
    if (trail.lastPartKind !== "text") {
        problems.push("the judge stream did not end on an answer");
    }
    return problems;
}

/** One attempt outcome, assembled once so each path stays small. */
function attemptOutcome(options: AttemptOutcome): AttemptOutcome {
    return options;
}

/** The transport or process failure outcome. */
function processOutcome(
    result: CommandResult,
    trail: ReturnType<typeof decodeTrail>,
    captureProblems: string[],
    complete: boolean,
): AttemptOutcome {
    const timedOut = result.timedOut ? ", timed out" : "";
    const errorNote = result.error === null ? "" : `, ${result.error}`;
    return attemptOutcome({
        status: "judge-error",
        failureClass: "transport-or-process",
        complete,
        captureProblems: [
            ...captureProblems,
            `judge process not ok (exit ${String(result.status)}${timedOut}${errorNote})`,
        ],
        judgement: null,
        problems: [],
        usage: trail.usage,
    });
}

/** Classify a complete captured answer against its recorded mutation state. */
function verdictOutcome(
    trail: ReturnType<typeof decodeTrail>,
    state: DocState,
    captureProblems: string[],
): AttemptOutcome {
    const parsed = parseAcJudgement(trail.text);
    const complete = true;
    if (parsed.value === undefined) {
        return attemptOutcome({
            status: "invalid-verdict",
            failureClass: judgeFailureClass({
                complete,
                problems: parsed.problems,
            }),
            complete,
            captureProblems,
            judgement: null,
            problems: parsed.problems,
            usage: trail.usage,
        });
    }
    const problems = validateAcJudgement(parsed.value, state);
    return problems.length > 0
        ? attemptOutcome({
              status: "invalid-verdict",
              failureClass: judgeFailureClass({
                  complete,
                  value: parsed.value,
                  problems,
              }),
              complete,
              captureProblems,
              judgement: parsed.value,
              problems,
              usage: trail.usage,
          })
        : attemptOutcome({
              status: "judged",
              failureClass: null,
              complete,
              captureProblems,
              judgement: parsed.value,
              problems: [],
              usage: trail.usage,
          });
}

/**
 * Classify one completed judge process against the recorded mutation state.
 * @param result The bounded process result.
 * @param state The documented mutation state the verdict must agree with.
 * @returns The terminal outcome, including any failure class.
 */
export function classifyAttempt(
    result: CommandResult,
    state: DocState,
): AttemptOutcome {
    const trail = decodeTrail(result.stdout);
    const captureProblems = judgeCapture(trail);
    const complete = captureProblems.length === 0 && trail.text.trim() !== "";
    const processFailed =
        result.timedOut ||
        result.error !== null ||
        result.signal !== null ||
        result.status !== 0;
    if (processFailed) {
        return processOutcome(result, trail, captureProblems, complete);
    }
    return complete
        ? verdictOutcome(trail, state, captureProblems)
        : attemptOutcome({
              status: "judge-error",
              failureClass: "empty-or-truncated",
              complete: false,
              captureProblems,
              judgement: null,
              problems: [],
              usage: trail.usage,
          });
}
