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
            problems.push(
                `saved meta ${field} does not describe the raw capture`,
            );
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

/** Compare the saved usage sidecar with its bound identity, when recorded. */
function usageProblems(
    trialDir: string,
    meta: Record<string, unknown>,
): string[] {
    if (typeof meta.usageSha256 !== "string") return [];
    const path = join(trialDir, "usage.json");
    if (!existsSync(path)) return ["the bound usage record is missing"];
    return sha256Bytes(readFileSync(path)) === meta.usageSha256
        ? []
        : ["the usage record does not match its bound identity"];
}

/** Problems with the validity claim and its recorded problem list. */
function validityProblems(meta: Record<string, unknown>): string[] {
    if (meta.captureValid !== true) {
        const saved = Array.isArray(meta.captureProblems)
            ? meta.captureProblems.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [];
        return saved.length > 0
            ? saved
            : ["metadata declared an invalid capture without a reason"];
    }
    return Array.isArray(meta.captureProblems) &&
        meta.captureProblems.length > 0
        ? ["metadata claims a valid capture but lists problems"]
        : [];
}

/** Flags in metadata that make a capture unusable regardless of content. */
function flagProblems(meta: Record<string, unknown>): string[] {
    const flags: Array<[boolean, string]> = [
        [meta.exit !== 0, `container exited ${String(meta.exit)}`],
        [meta.timedOut === true, "container timed out"],
        [
            typeof meta.error === "string" && meta.error !== "",
            `container error: ${String(meta.error)}`,
        ],
        [
            meta.overflowed === true,
            "the captured output exceeded its byte limit",
        ],
    ];
    return flags.filter(([present]) => present).map(([, problem]) => problem);
}

/** Validity problems the saved metadata itself declares. */
function metaProblems(meta: Record<string, unknown>): string[] {
    return [...validityProblems(meta), ...flagProblems(meta)];
}

/** Metadata-only problems, including identity and declaration checks. */
function metadataProblems(
    meta: Record<string, unknown> | null,
    expected: { campaignId?: string; slotId?: string },
): string[] {
    return meta === null
        ? ["capture metadata is missing or unreadable"]
        : [...identityProblems(meta, expected), ...metaProblems(meta)];
}

/** Raw-stream and bound-artifact problems. */
function artifactProblems(options: {
    trialDir: string;
    hasEvents: boolean;
    trail: DecodedTrail;
    meta: Record<string, unknown> | null;
}): string[] {
    const problems = captureProblems(options.trail);
    if (!options.hasEvents)
        return ["the raw event stream is missing", ...problems];
    problems.push(
        ...answerProblems(options.trialDir, options.trail, options.meta ?? {}),
        ...usageProblems(options.trialDir, options.meta ?? {}),
    );
    if (options.meta !== null) {
        problems.push(...counterProblems(options.meta, options.trail));
    }
    return problems;
}

/**
 * Derive capture validity for one trial directory and reconcile it with the
 * saved metadata and bound artifacts.
 * @param trialDir The trial evidence directory.
 * @param expected The campaign/slot identity the capture must match.
 * @param expected.campaignId The campaign the capture must belong to.
 * @param expected.slotId The slot the capture must belong to.
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
    const raw = hasEvents ? readFileSync(eventsPath, "utf8") : "";
    const trail = decodeTrail(raw);
    const unique = [
        ...new Set([
            ...metadataProblems(metaValue, expected),
            ...artifactProblems({
                trialDir,
                hasEvents,
                trail,
                meta: metaValue,
            }),
        ]),
    ];
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
