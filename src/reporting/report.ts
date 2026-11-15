import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Of } from "../contracts/canonical.ts";
import { isRecord } from "../contracts/validate.ts";
import { loadPreparedManifest } from "../campaign/prepare.ts";
import { loadFrozen } from "../campaign/freeze.ts";
import { readLedger } from "../campaign/ledger.ts";
import { readAssessments, type StoredAssessment } from "../campaign/assess.ts";
import { readSelectedJudgement } from "../campaign/judge.ts";
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
        judgement: {
            selectedAttemptId: string;
            attempts: number;
            documentationOutcome: string | null;
            utility: number | null;
            status: string;
        } | null;
    }>;
}

/** A report render result. */
export type ReportResult =
    | { ok: true; report: Report; markdown: string; outDir: string }
    | { ok: false; problems: string[] };

/** Read a trial's usage record, or null. */
function readUsage(
    root: string,
    slotId: string,
): Record<string, unknown> | null {
    const path = join(trialDirectory(root, slotId), "usage.json");
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
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

/** The per-run usage section. */
function usageSection(report: Report): string[] {
    return report.slots.flatMap((slot) => {
        const usage = slot.usage;
        if (usage === null)
            return [`- ${slot.slotId}: unknown (no usage record)`];
        return [
            `- ${slot.slotId}: input ${String(usage.inputTokens ?? "unknown")}, output ${String(usage.outputTokens ?? "unknown")}, cache read ${String(usage.cacheReadTokens ?? "unknown")}, reported ${String(usage.reported ?? false)}`,
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
        "",
        "## Per-run usage",
        "",
        ...usageSection(report),
        "",
    ].join("\n");
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
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) {
        return { ok: false, problems: [prepared.problem] };
    }
    const frozen = loadFrozen(root);
    if (!frozen.ok) return { ok: false, problems: [frozen.problem] };
    const ledger = readLedger(root);
    if (ledger.state !== "closed") {
        return {
            ok: false,
            problems: [
                `campaign is ${ledger.state}; close it before the final analysis`,
            ],
        };
    }
    if (existsSync(outDir)) {
        return {
            ok: false,
            problems: [
                `${outDir} already exists; reports are never overwritten`,
            ],
        };
    }
    const assessments = readAssessments(root);
    const slots = prepared.manifest.campaign.schedule.slots.map((slot) => {
        const assessment = assessments.find(
            (entry) => entry.slotId === slot.slotId,
        );
        if (assessment === undefined) {
            return {
                slotId: slot.slotId,
                caseId: slot.caseId,
                armId: slot.armId,
                repetitionId: slot.repetitionId,
                expected: "unknown",
                observed: "unrun",
                validity: "unrun",
                outcome: "unknown",
                reasons: ["no assessment was recorded"],
                counts: {},
                usage: readUsage(root, slot.slotId),
                judgement: judgementOf(root, slot.slotId),
            };
        }
        const observed = observedOf(assessment);
        return {
            slotId: slot.slotId,
            caseId: slot.caseId,
            armId: slot.armId,
            repetitionId: slot.repetitionId,
            ...observed,
            validity: assessment.validity,
            outcome: assessment.outcome,
            reasons: assessment.reasons,
            usage: readUsage(root, slot.slotId),
            judgement: judgementOf(root, slot.slotId),
        };
    });
    const body = {
        schemaVersion: 1 as const,
        campaignId: prepared.manifest.campaignId,
        suiteId: prepared.manifest.suiteId,
        closedAt: ledger.closedAt,
        imageId: frozen.record.imageId,
        generatedAt: now(),
        denominators: {
            scheduled: slots.length,
            assessed: assessments.length,
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
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
        join(outDir, "report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
    );
    writeFileSync(join(outDir, "report.md"), markdown, "utf8");
    return { ok: true, report, markdown, outDir };
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
