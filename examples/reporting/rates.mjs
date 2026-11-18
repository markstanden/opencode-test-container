#!/usr/bin/env node
/**
 * Per-case, per-arm rates from an OTC `report.json`.
 *
 * OTC scores slots and never collapses them into a rate. Two different rates
 * matter, and they answer different questions:
 *
 * - activation rate: valid slots that observed target activation / valid slots.
 *   A positive case usually wants this high; a negative wants it low.
 * - criterion pass rate: valid slots scored pass / valid slots. High is good for
 *   both expectations, because a correct negative is a pass without activation.
 *
 * Only valid slots enter either denominator; invalid, unknown and unrun slots
 * are reported separately. With no valid slots the rate is unavailable, not
 * zero.
 *
 * Usage: node rates.mjs <report.json> [--control <caseId>]…
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A valid-vs-observed count pair; `rate` is null when nothing was valid. */
function ratio(count, denominator) {
    return {
        count,
        denominator,
        rate: denominator === 0 ? null : count / denominator,
    };
}

/** The empty accumulator for one case and arm. */
function emptyRow(caseId, armId, expected, control) {
    return {
        caseId,
        armId,
        expected,
        control,
        scheduled: 0,
        valid: 0,
        activation: 0,
        pass: 0,
        excluded: { invalid: 0, unknown: 0, unrun: 0 },
    };
}

/** Add one slot to its case-and-arm row. */
function accumulate(row, slot) {
    row.scheduled += 1;
    if (slot.validity === "valid") {
        row.valid += 1;
        if (slot.observed === "target-activation") row.activation += 1;
        if (slot.outcome === "pass") row.pass += 1;
        return;
    }
    if (slot.validity === "invalid") {
        row.excluded.invalid += 1;
        return;
    }
    if (slot.validity === "unknown") {
        row.excluded.unknown += 1;
        return;
    }
    row.excluded.unrun += 1;
}

/**
 * Summarise a report into one row per case and arm. Settings may name
 * explicit-invocation control case ids.
 * @param report The `report.json` document.
 * @param [options] Optional settings.
 * @returns Treatment rows and control rows, each with both rates.
 */
export function summariseRates(report, options = {}) {
    const controls = new Set(options.controls ?? []);
    const rows = new Map();
    for (const slot of report?.slots ?? []) {
        const caseId = String(slot.caseId);
        const armId = String(slot.armId);
        const key = `${caseId}\u0000${armId}`;
        let row = rows.get(key);
        if (row === undefined) {
            row = emptyRow(
                caseId,
                armId,
                String(slot.expected ?? ""),
                controls.has(caseId),
            );
            rows.set(key, row);
        }
        accumulate(row, slot);
    }
    const described = [...rows.values()]
        .map((row) => ({
            caseId: row.caseId,
            armId: row.armId,
            expected: row.expected,
            control: row.control,
            scheduled: row.scheduled,
            valid: row.valid,
            activation: ratio(row.activation, row.valid),
            pass: ratio(row.pass, row.valid),
            excluded: row.excluded,
        }))
        .sort((left, right) =>
            left.caseId === right.caseId
                ? left.armId.localeCompare(right.armId)
                : left.caseId.localeCompare(right.caseId),
        );
    return {
        rows: described.filter((row) => !row.control),
        controls: described.filter((row) => row.control),
    };
}

/** One rate as `count/denominator` or `unavailable`. */
function cell(count, denominator) {
    return denominator === 0 ? "unavailable" : `${count}/${denominator}`;
}

/** The Markdown table for one group of rows. */
function table(rows) {
    const lines = [
        "| Case | Arm | Expected | Valid | Activation | Pass | Invalid | Unknown | Unrun |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const row of rows) {
        lines.push(
            `| ${row.caseId} | ${row.armId} | ${row.expected} | ${row.valid}/${row.scheduled} | ${cell(
                row.activation.count,
                row.activation.denominator,
            )} | ${cell(row.pass.count, row.pass.denominator)} | ${row.excluded.invalid} | ${row.excluded.unknown} | ${row.excluded.unrun} |`,
        );
    }
    return lines.join("\n");
}

/**
 * Render a summary as Markdown, with controls kept in their own section.
 * @param summary The value returned by {@link summariseRates}.
 * @returns A Markdown document.
 */
export function renderRates(summary) {
    if (summary.rows.length === 0 && summary.controls.length === 0) {
        return "No slots in this report.";
    }
    const sections = [
        "Activation is target activation over valid slots; pass is the criterion outcome over valid slots. A correct negative passes without activating.",
    ];
    if (summary.rows.length > 0) sections.push(table(summary.rows));
    if (summary.controls.length > 0) {
        sections.push(
            "## Controls (explicit invocation; not a trigger rate)",
            table(summary.controls),
        );
    }
    return sections.join("\n\n");
}

/** Read the CLI arguments: one report path and zero or more control case ids. */
function options(argv) {
    const controls = [];
    let path = "";
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--control") {
            index += 1;
            if (argv[index] !== undefined) controls.push(argv[index]);
            continue;
        }
        if (path === "") path = argument;
    }
    return { path, controls };
}

if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const { path, controls } = options(process.argv.slice(2));
    if (path === "") {
        console.error(
            "usage: node rates.mjs <report.json> [--control <caseId>]…",
        );
        process.exit(2);
    }
    const report = JSON.parse(readFileSync(path, "utf8"));
    console.log(renderRates(summariseRates(report, { controls })));
}
