import {
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256Bytes, sha256Of } from "../contracts/canonical.ts";
import { canonicalPath, pathWithin } from "../evidence/paths.ts";
import { isRecord } from "../contracts/validate.ts";
import {
    loadPreparedManifest,
    type PreparedManifest,
} from "../campaign/prepare.ts";
import { deliveryCheck, loadFrozen } from "../campaign/freeze.ts";
import { readLedger } from "../campaign/ledger.ts";
import type { StoredAssessment } from "../campaign/assess.ts";
import { checkedAssessments } from "../evidence/assessments.ts";
import {
    checkedSelectionForSlot,
    readSelectedJudgement,
} from "../campaign/judge.ts";
import { trialDirectory } from "../campaign/run.ts";

/** The derived report document. */
export interface Report {
    /** The schema version value. */
    schemaVersion: 1;
    /** The campaign id value. */
    campaignId: string;
    /** The suite id value. */
    suiteId: string;
    /** The report sha256 value. */
    reportSha256: string;
    /** The closed at value. */
    closedAt: string | null;
    /** The image id value. */
    imageId: string;
    /** The generated at value. */
    generatedAt: string;
    /** The denominators value. */
    denominators: {
        scheduled: number;
        assessed: number;
        valid: number;
        invalid: number;
        unknown: number;
        unrun: number;
        judged: number;
        unjudged: number;
    };
    /** The totals value. */
    totals: { pass: number; fail: number; unknown: number };
    /** The slots value. */
    slots: Array<{
        slotId: string;
        caseId: string;
        armId: string;
        repetitionId: string;
        expected: string;
        observed: string;
        validity: string;
        outcome: string;
        reasons: string[];
        counts: Record<string, number>;
        usage: Record<string, unknown> | null;
        /** Why the usage record is not trusted, when it is not. */
        usageProblems: string[];
        judgement: {
            selectedAttemptId: string;
            attempts: number;
            documentationOutcome: string | null;
            utility: number | null;
            status: string;
        } | null;
        judgeProblems: string[];
    }>;
}

/** A report render result. */
export type ReportResult =
    | { ok: true; report: Report; markdown: string; outDir: string }
    | { ok: false; problems: string[] };

/**
 * Read a trial's usage record against the identity bound into its capture
 * metadata. Cost and tokens are accepted figures only when the sidecar still
 * hashes to what the trial recorded; a changed or lost sidecar becomes an
 * explicit unknown, never a quietly different number. A historical capture
 * with no bound identity keeps its unknown/partial usage but is labelled
 * unverified.
 */
function readUsage(
    root: string,
    slotId: string,
): { usage: Record<string, unknown> | null; problems: string[] } {
    const trialDir = trialDirectory(root, slotId);
    const path = join(trialDir, "usage.json");
    const metaPath = join(trialDir, "meta.json");
    let meta: Record<string, unknown> | null = null;
    if (existsSync(metaPath)) {
        try {
            const value: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
            meta = isRecord(value) ? value : null;
        } catch {
            meta = null;
        }
    }
    const bound =
        meta !== null && typeof meta.usageSha256 === "string"
            ? meta.usageSha256
            : null;
    if (!existsSync(path)) {
        return {
            usage: null,
            problems:
                bound === null
                    ? []
                    : ["the bound usage record is missing"],
        };
    }
    const bytes = readFileSync(path);
    if (bound === null) {
        return {
            usage: parseUsage(bytes),
            problems: [
                "historical capture has no bound usage identity; the figures are unverified",
            ],
        };
    }
    if (sha256Bytes(bytes) !== bound) {
        return {
            usage: null,
            problems: ["the usage record does not match its bound identity"],
        };
    }
    return { usage: parseUsage(bytes), problems: [] };
}

/** Parse one usage sidecar without trusting its shape. */
function parseUsage(bytes: Buffer): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** The expected/observed pair for either evaluator. */
function observedOf(assessment: StoredAssessment): {
    expected: string;
    observed: string;
    counts: Record<string, number>;
} {
    if (assessment.kind === "skill-activation") {
        return {
            expected: assessment.expected,
            observed: assessment.observed,
            counts: assessment.counts as unknown as Record<string, number>,
        };
    }
    return {
        expected: assessment.expected,
        observed: assessment.outcome,
        counts: assessment.counts as unknown as Record<string, number>,
    };
}

/** The selected judgement summary for one slot. */
function judgementOf(
    root: string,
    slotId: string,
): Report["slots"][number]["judgement"] {
    const selected = readSelectedJudgement(root, slotId);
    if (selected === null) return null;
    return {
        selectedAttemptId: selected.selection.selectedAttemptId,
        attempts: selected.selection.attempts.length,
        documentationOutcome: selected.judgement.documentationOutcome,
        utility: selected.judgement.utility,
        status: selected.judgement.status,
    };
}

/** The packet and selection integrity diagnostics for one judged slot. */
function judgeProblemsOf(
    root: string,
    manifest: PreparedManifest,
    slotId: string,
): string[] {
    if (manifest.campaign.assessment.judge === undefined) return [];
    const checked = checkedSelectionForSlot(root, slotId);
    return checked.ok ? [] : checked.problems;
}

/** The slot table rows. */
function slotRows(report: Report): string[] {
    return report.slots.map((slot) => {
        const counts = Object.entries(slot.counts)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ");
        return `| ${slot.slotId} | ${slot.caseId} | ${slot.armId} | ${slot.repetitionId} | ${slot.expected} | ${slot.observed} | ${slot.validity} | ${slot.outcome} | ${counts} | ${slot.judgement === null ? "unjudged" : `${slot.judgement.documentationOutcome} (${String(slot.judgement.utility)}); ${slot.judgement.selectedAttemptId}`} |`;
    });
}

/** The refusal and unknown section, when any slot has a reason. */
function reasonSection(report: Report): string[] {
    const reasons = report.slots.filter((slot) => slot.reasons.length > 0);
    if (reasons.length === 0) return [];
    return [
        "",
        "## Refusals and unknowns",
        "",
        ...reasons.map(
            (slot) => `- **${slot.slotId}**: ${slot.reasons.join("; ")}`,
        ),
    ];
}

/** The judge integrity section, when any slot has a diagnostic. */
function judgeIntegritySection(report: Report): string[] {
    const problems = report.slots.filter(
        (slot) => slot.judgeProblems.length > 0,
    );
    if (problems.length === 0) return [];
    return [
        "",
        "## Judge integrity",
        "",
        ...problems.flatMap((slot) =>
            slot.judgeProblems.map(
                (problem) => `- **${slot.slotId}**: ${problem}`,
            ),
        ),
    ];
}

/** The per-run usage section, with any unverified record named. */
function usageSection(report: Report): string[] {
    return report.slots.flatMap((slot) => {
        const usage = slot.usage;
        const note =
            slot.usageProblems.length === 0
                ? ""
                : ` [${slot.usageProblems.join("; ")}]`;
        if (usage === null)
            return [`- ${slot.slotId}: unknown (no accepted usage record)${note}`];
        return [
            `- ${slot.slotId}: input ${String(usage.inputTokens ?? "unknown")}, output ${String(usage.outputTokens ?? "unknown")}, cache read ${String(usage.cacheReadTokens ?? "unknown")}, reported ${String(usage.reported ?? false)}${note}`,
        ];
    });
}

/** Render the human-readable report. */
function markdownOf(report: Report): string {
    return [
        `# OTC report — ${report.campaignId}`,
        "",
        `- Suite: \`${report.suiteId}\``,
        `- Image: \`${report.imageId}\``,
        `- Closed: ${report.closedAt ?? "no"}`,
        `- Generated: ${report.generatedAt}`,
        `- Report identity: \`${report.reportSha256}\``,
        "",
        "## Denominator",
        "",
        `Scheduled ${report.denominators.scheduled}; assessed ${report.denominators.assessed}; valid ${report.denominators.valid}; invalid ${report.denominators.invalid}; unknown ${report.denominators.unknown}; unrun ${report.denominators.unrun}; judged ${report.denominators.judged}; unjudged ${report.denominators.unjudged}.`,
        "",
        `Pass ${report.totals.pass}; fail ${report.totals.fail}; unknown ${report.totals.unknown}. The valid denominator is pass + fail (${report.totals.pass + report.totals.fail}); invalid and unrun runs are excluded and listed below.`,
        "",
        "## Slots",
        "",
        "| Slot | Case | Arm | Rep | Expected | Observed | Validity | Outcome | Counts | Judgement |",
        "| ---- | ---- | --- | --- | -------- | -------- | -------- | ------- | ------ | --------- |",
        ...slotRows(report),
        ...reasonSection(report),
        ...judgeIntegritySection(report),
        "",
        "## Per-run usage",
        "",
        ...usageSection(report),
        "",
    ].join("\n");
}

/** One report record per scheduled slot, with unrun rows derived. */
function slotRecords(
    root: string,
    manifest: PreparedManifest,
    assessmentBySlot: ReadonlyMap<string, StoredAssessment>,
): Report["slots"] {
    return manifest.campaign.schedule.slots.map((slot) => {
        const assessment = assessmentBySlot.get(slot.slotId);
        const judgement = judgementOf(root, slot.slotId);
        const judgeProblems = judgeProblemsOf(root, manifest, slot.slotId);
        const identity = {
            slotId: slot.slotId,
            caseId: slot.caseId,
            armId: slot.armId,
            repetitionId: slot.repetitionId,
        };
        const usage = readUsage(root, slot.slotId);
        if (assessment === undefined) {
            return {
                ...identity,
                expected: "unknown",
                observed: "unrun",
                validity: "unrun",
                outcome: "unknown",
                reasons: ["no assessment was recorded"],
                counts: {},
                usage: usage.usage,
                usageProblems: usage.problems,
                judgement,
                judgeProblems,
            };
        }
        return {
            ...identity,
            ...observedOf(assessment),
            validity: assessment.validity,
            outcome: assessment.outcome,
            reasons: assessment.reasons,
            usage: usage.usage,
            usageProblems: usage.problems,
            judgement,
            judgeProblems,
        };
    });
}

/** The readable state a final report needs. */
type ReportState =
    | {
          ok: true;
          prepared: ReturnType<typeof loadPreparedManifest> & { ok: true };
          frozen: ReturnType<typeof loadFrozen> & { ok: true };
          ledger: ReturnType<typeof readLedger>;
      }
    | { ok: false; problems: string[] };

/** Load the prepared, frozen and closed state or the refusals. */
function reportState(root: string): ReportState {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const frozen = loadFrozen(root);
    if (!frozen.ok) return { ok: false, problems: [frozen.problem] };
    const drift = deliveryCheck(root);
    if (drift.length > 0) {
        return { ok: false, problems: ["delivery check failed", ...drift] };
    }
    const ledger = readLedger(root);
    if (ledger.state !== "closed") {
        return {
            ok: false,
            problems: [
                `campaign is ${ledger.state}; close it before the final analysis`,
            ],
        };
    }
    return { ok: true, prepared, frozen, ledger };
}

/** Checked assessments, refusing a started slot with no valid record. */
function reportAssessments(
    root: string,
    manifest: PreparedManifest,
    ledger: ReturnType<typeof readLedger>,
):
    | { ok: true; bySlot: Map<string, StoredAssessment> }
    | { ok: false; problems: string[] } {
    const checked = checkedAssessments({ root, manifest, ledger });
    if (checked.problems.length > 0) {
        return {
            ok: false,
            problems: [
                "assessment evidence is not trustworthy",
                ...checked.problems,
            ],
        };
    }
    const bySlot = new Map(
        checked.records.flatMap((entry) =>
            entry.state === "valid" && entry.record !== null
                ? [[entry.slotId, entry.record] as const]
                : [],
        ),
    );
    const startedWithout = ledger.events
        .filter((event) => event.event === "trial-start")
        .flatMap((event) =>
            typeof event.slotId === "string" &&
            event.slotId !== "" &&
            !bySlot.has(event.slotId)
                ? [event.slotId]
                : [],
        );
    return startedWithout.length > 0
        ? {
              ok: false,
              problems: [
                  `started slot(s) have no checked assessment: ${startedWithout.join(", ")}`,
              ],
          }
        : { ok: true, bySlot };
}

/**
 * Render the final analysis from checked evidence. Requires a closed ledger
 * and writes only to a fresh output directory outside the evidence tree.
 * @param root The campaign root.
 * @param outDir The fresh report directory.
 * @param now Injected clock.
 * @returns The report, or the refusals.
 */
export function analyseCampaign(
    root: string,
    outDir: string,
    now: () => string = () => new Date().toISOString(),
): ReportResult {
    const state = reportState(root);
    if (!state.ok) return { ok: false, problems: state.problems };
    if (existsSync(outDir)) {
        return {
            ok: false,
            problems: [
                `${outDir} already exists; reports are never overwritten`,
            ],
        };
    }
    const unsafe = unsafeOutputProblems(root, outDir);
    if (unsafe.length > 0) return { ok: false, problems: unsafe };
    const assessed = reportAssessments(
        root,
        state.prepared.manifest,
        state.ledger,
    );
    if (!assessed.ok) return { ok: false, problems: assessed.problems };
    const assessmentBySlot = assessed.bySlot;
    const slots = slotRecords(root, state.prepared.manifest, assessmentBySlot);
    const body = {
        schemaVersion: 1 as const,
        campaignId: state.prepared.manifest.campaignId,
        suiteId: state.prepared.manifest.suiteId,
        closedAt: state.ledger.closedAt,
        imageId: state.frozen.record.imageId,
        generatedAt: now(),
        denominators: {
            scheduled: slots.length,
            assessed: assessmentBySlot.size,
            valid: slots.filter((slot) => slot.validity === "valid").length,
            invalid: slots.filter((slot) => slot.validity === "invalid").length,
            unknown: slots.filter((slot) => slot.validity === "unknown").length,
            unrun: slots.filter((slot) => slot.validity === "unrun").length,
            judged: slots.filter((slot) => slot.judgement !== null).length,
            unjudged: slots.filter((slot) => slot.judgement === null).length,
        },
        totals: {
            pass: slots.filter((slot) => slot.outcome === "pass").length,
            fail: slots.filter((slot) => slot.outcome === "fail").length,
            unknown: slots.filter((slot) => slot.outcome === "unknown").length,
        },
        slots,
    };
    const report: Report = { ...body, reportSha256: sha256Of(body) };
    const markdown = markdownOf(report);
    const staging = `${outDir}.tmp-${randomBytes(6).toString("hex")}`;
    try {
        mkdirSync(staging, { recursive: true });
        writeFileSync(
            join(staging, "report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8",
        );
        writeFileSync(join(staging, "report.md"), markdown, "utf8");
        renameSync(staging, outDir);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        return {
            ok: false,
            problems: [
                `the report could not be published atomically: ${error instanceof Error ? error.message : String(error)}`,
            ],
        };
    }
    return { ok: true, report, markdown, outDir };
}

/** Protected trees a report may never be written into. */
function protectedTrees(root: string): string[] {
    return [join(root, "evidence"), join(root, "prepare")]
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path));
}

/**
 * Refuse a report destination inside protected evidence or prepared inputs,
 * resolving symlinked parents. A sibling `reports/` directory is allowed, as
 * is a child whose name merely starts with dots; containment is compared by
 * path components, never by a string prefix.
 */
function unsafeOutputProblems(root: string, outDir: string): string[] {
    const target = canonicalPath(outDir);
    return protectedTrees(root).flatMap((protectedRoot) =>
        pathWithin(protectedRoot, target)
            ? [`report destination ${outDir} is inside protected evidence`]
            : [],
    );
}

/** The canonical identity of a report without its own identity field. */
export function reportIdentity(report: Report): string {
    const body: Record<string, unknown> = { ...report };
    delete body.reportSha256;
    return sha256Of(body);
}

/** Ensure a report's identity still matches its content. */
export function reportIntact(report: Report): boolean {
    return reportIdentity(report) === report.reportSha256;
}
