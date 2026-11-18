/** One counted rate; `rate` is null when the denominator is zero. */
export interface CountedRate {
    /** Matching slots. */
    count: number;
    /** Valid slots used as the denominator. */
    denominator: number;
    /** count / denominator, or null when nothing was valid. */
    rate: number | null;
}

/** Excluded slots by validity, kept visible beside the denominator. */
export interface Exclusions {
    /** Invalid slots. */
    invalid: number;
    /** Unknown slots. */
    unknown: number;
    /** Unrun slots. */
    unrun: number;
}

/** One case-and-arm rate row. */
export interface RateRow {
    /** Case id. */
    caseId: string;
    /** Arm id. */
    armId: string;
    /** The case's declared expectation. */
    expected: string;
    /** Whether the case was listed as a control. */
    control: boolean;
    /** Scheduled slots for this case and arm. */
    scheduled: number;
    /** Valid slots. */
    valid: number;
    /** Target activations over valid slots. */
    activation: CountedRate;
    /** Criterion passes over valid slots. */
    pass: CountedRate;
    /** Slots excluded from both denominators. */
    excluded: Exclusions;
}

/** Treatment rows and separately reported controls. */
export interface RateSummary {
    /** Non-control rows. */
    rows: RateRow[];
    /** Cases listed through `--control`. */
    controls: RateRow[];
}

/** The report fields the merge and summary read. */
export interface ReportLike {
    /** Campaign identity, when present. */
    campaignId?: unknown;
    /** Suite identity, when present. */
    suiteId?: unknown;
    /** Slot rows. */
    slots?: readonly Record<string, unknown>[];
}

/**
 * Merge disjoint shard reports into one checked document.
 * @param reports Parsed `report.json` documents from separate roots.
 * @returns The merged report; duplicate slots or different campaigns throw.
 */
export function mergeReports(reports: readonly ReportLike[]): ReportLike;

/** Summarise a report into one row per case and arm. */
export function summariseRates(
    report: unknown,
    options?: { controls?: readonly string[] },
): RateSummary;

/** Render a summary as Markdown. */
export function renderRates(summary: RateSummary): string;
