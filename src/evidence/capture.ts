/**
 * Checked capture evidence.
 *
 * A saved `meta.json` is a claim; the raw event stream is the observation. This
 * module derives capture validity from the raw bytes and reconciles the saved
 * metadata with what the decoder actually saw, so a malformed or truncated
 * stream cannot pass merely because a flag says it was valid. Evaluators and
 * other evidence consumers use this one vocabulary.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    captureProblems,
    decodeTrail,
    type DecodedTrail,
} from "../adapters/opencode/events.ts";
import { sha256Bytes } from "../contracts/canonical.ts";
import { isRecord } from "../contracts/validate.ts";
import type { TrialMeta } from "../campaign/run.ts";

/** The checked state of one trial capture. */
export type CaptureCheck =
    | {
          state: "unrun";
          problems: string[];
          meta: null;
          trail: null;
          raw: null;
      }
    | {
          state: "invalid";
          problems: string[];
          meta: TrialMeta | null;
          trail: DecodedTrail;
          raw: string;
      }
    | {
          state: "valid";
          problems: [];
          meta: TrialMeta;
          trail: DecodedTrail;
          raw: string;
      };

/** Read one JSON object without trusting it. */
function readRecord(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** Compare one saved metadata counter with the decoded trail. */
function counterProblems(
    meta: Record<string, unknown>,
    trail: DecodedTrail,
): string[] {
    const problems: string[] = [];
    const fields: Array<[string, unknown, unknown]> = [
        ["events", meta.events, trail.events],
        ["parseFailures", meta.parseFailures, trail.parseFailures],
        ["textParts", meta.textParts, trail.textParts],
        ["lastPartKind", meta.lastPartKind, trail.lastPartKind],
        ["answerSha256", meta.answerSha256, sha256Bytes(trail.text)],
    ];
    for (const [field, saved, observed] of fields) {
        if (saved !== undefined && saved !== observed) {
            problems.push(`saved meta ${field} does not describe the raw capture`);
        }
    }
    return problems;
}

/** Identity checks for one trial's metadata. */
function identityProblems(
    meta: Record<string, unknown>,
    expected: { campaignId?: string; slotId?: string },
): string[] {
    const problems: string[] = [];
    if (
        expected.campaignId !== undefined &&
        typeof meta.campaignId === "string" &&
        meta.campaignId !== expected.campaignId
    ) {
        problems.push("capture belongs to a different campaign");
    }
    if (
        expected.slotId !== undefined &&
        typeof meta.slotId === "string" &&
        meta.slotId !== expected.slotId
    ) {
        problems.push("capture belongs to a different slot");
    }
    return problems;
}

/** Compare the saved answer artifact with the captured answer text. */
function answerProblems(
    trialDir: string,
    trail: DecodedTrail,
    meta: Record<string, unknown>,
): string[] {
    const answerPath = join(trialDir, "answer.md");
    const recorded = typeof meta.answerSha256 === "string";
    if (!existsSync(answerPath)) {
        return recorded ? ["the answer record is missing"] : [];
    }
    const saved = readFileSync(answerPath);
    return sha256Bytes(saved) === sha256Bytes(trail.text)
        ? []
        : ["the answer record does not match the raw capture"];
}

/** Validity problems the saved metadata itself declares. */
function metaProblems(meta: Record<string, unknown>): string[] {
    const problems: string[] = [];
    if (meta.captureValid !== true) {
        const saved = Array.isArray(meta.captureProblems)
            ? meta.captureProblems.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [];
        problems.push(...saved);
        if (saved.length === 0) {
            problems.push("metadata declared an invalid capture without a reason");
        }
    } else if (
        Array.isArray(meta.captureProblems) &&
        meta.captureProblems.length > 0
    ) {
        problems.push("metadata claims a valid capture but lists problems");
    }
    if (meta.exit !== 0) {
        problems.push(`container exited ${String(meta.exit)}`);
    }
    if (meta.timedOut === true) problems.push("container timed out");
    if (typeof meta.error === "string" && meta.error !== "") {
        problems.push(`container error: ${meta.error}`);
    }
    if (meta.overflowed === true) {
        problems.push("the captured output exceeded its byte limit");
    }
    return problems;
}

/**
 * Derive capture validity for one trial directory and reconcile it with the
 * saved metadata and bound artifacts.
 * @param trialDir The trial evidence directory.
 * @param expected The campaign/slot identity the capture must match.
 * @returns The checked capture state.
 */
export function checkCapture(
    trialDir: string,
    expected: { campaignId?: string; slotId?: string } = {},
): CaptureCheck {
    const metaValue = readRecord(join(trialDir, "meta.json"));
    const eventsPath = join(trialDir, "events.jsonl");
    const hasEvents = existsSync(eventsPath);
    if (metaValue === null && !hasEvents) {
        return {
            state: "unrun",
            problems: ["trial evidence is missing"],
            meta: null,
            trail: null,
            raw: null,
        };
    }
    const problems: string[] = [];
    if (metaValue === null) {
        problems.push("capture metadata is missing or unreadable");
    } else {
        problems.push(
            ...identityProblems(metaValue, expected),
            ...metaProblems(metaValue),
        );
    }
    const raw = hasEvents ? readFileSync(eventsPath, "utf8") : "";
    if (!hasEvents) problems.push("the raw event stream is missing");
    const trail = decodeTrail(raw);
    problems.push(...captureProblems(trail));
    if (hasEvents) {
        problems.push(...answerProblems(trialDir, trail, metaValue ?? {}));
        if (metaValue !== null) {
            problems.push(...counterProblems(metaValue, trail));
        }
    }
    const unique = [...new Set(problems)];
    const meta = metaValue as unknown as TrialMeta | null;
    return unique.length === 0 && meta !== null && hasEvents
        ? {
              state: "valid",
              problems: [],
              meta,
              trail,
              raw,
          }
        : {
              state: "invalid",
              problems:
                  unique.length === 0
                      ? ["capture evidence is incomplete"]
                      : unique,
              meta,
              trail,
              raw,
          };
}
