/**
 * Pure report calculation.
 *
 * Loading checked rows, rendering Markdown and publishing files stay in
 * `report.ts`; this module turns checked rows and metadata into the report
 * value and its canonical identity.
 */
import { sha256Of } from "../contracts/canonical.ts";
import type { Report } from "./report.ts";

/** The explicit values one report is calculated from. */
export interface ReportValues {
    /** The campaign identity. */
    campaignId: string;
    /** The suite identity. */
    suiteId: string;
    /** The recorded closure time, or null. */
    closedAt: string | null;
    /** The frozen image identity. */
    imageId: string;
    /** The injected generation time. */
    generatedAt: string;
    /** The number of slots with a checked assessment. */
    assessed: number;
    /** The checked per-slot rows. */
    slots: Report["slots"];
}

/**
 * Calculate one report from checked rows, the assessed count and metadata.
 * @param values The checked rows and metadata.
 * @returns The derived report.
 */
export function reportFor(values: ReportValues): Report {
    const body = {
        schemaVersion: 1 as const,
        campaignId: values.campaignId,
        suiteId: values.suiteId,
        closedAt: values.closedAt,
        imageId: values.imageId,
        generatedAt: values.generatedAt,
        denominators: {
            scheduled: values.slots.length,
            assessed: values.assessed,
            valid: values.slots.filter((slot) => slot.validity === "valid")
                .length,
            invalid: values.slots.filter(
                (slot) => slot.validity === "invalid",
            ).length,
            unknown: values.slots.filter(
                (slot) => slot.validity === "unknown",
            ).length,
            unrun: values.slots.filter((slot) => slot.validity === "unrun")
                .length,
            judged: values.slots.filter((slot) => slot.judgement !== null)
                .length,
            unjudged: values.slots.filter((slot) => slot.judgement === null)
                .length,
        },
        totals: {
            pass: values.slots.filter((slot) => slot.outcome === "pass").length,
            fail: values.slots.filter((slot) => slot.outcome === "fail").length,
            unknown: values.slots.filter((slot) => slot.outcome === "unknown")
                .length,
        },
        slots: values.slots,
    };
    return { ...body, reportSha256: sha256Of(body) };
}
