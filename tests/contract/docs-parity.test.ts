import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../../src/evaluators/docs/analysis/replay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-parity");
const EXPECTED = join(FIXTURE, "expected");

/** Read one JSON fixture. */
function json(path: string): unknown {
    return JSON.parse(readFileSync(path, "utf8"));
}

/** Read the expected receipt with its volatile render time removed. */
function receiptWithoutTime(path: string): Record<string, unknown> {
    const value = json(path) as Record<string, unknown>;
    delete value.renderedAt;
    return value;
}

describe("docs evaluator semantic parity", () => {
    it("replays recorded evidence with identical accounting, measures, guardrails, bounds and decision", () => {
        // Arrange
        const out = mkdtempSync(join(tmpdir(), "otc-parity-"));
        try {
            // Act
            const run = runAnalysis([
                "--campaign",
                join(FIXTURE, "manifest.json"),
                "--evidence-root",
                join(FIXTURE, "evidence"),
                "--out",
                out,
            ]);

            // Assert
            assert.equal(run.status, 0, run.messages.join("; "));
            const analysis = json(join(out, "analysis.json"));
            assert.deepEqual(analysis, json(join(EXPECTED, "analysis.json")));
            assert.equal(
                readFileSync(join(out, "REPORT.md"), "utf8"),
                readFileSync(join(EXPECTED, "REPORT.md"), "utf8"),
            );
            assert.deepEqual(
                json(join(out, "SCREENING.json")),
                json(join(EXPECTED, "SCREENING.json")),
            );
            assert.deepEqual(
                receiptWithoutTime(join(out, "analysis-receipt.json")),
                receiptWithoutTime(join(EXPECTED, "analysis-receipt.json")),
            );
            const typed = analysis as {
                decision: { overall: string };
                totals: { planned: number; completed: number };
                arms: Record<string, unknown>;
                guardrails: unknown[];
                bounds: unknown;
                measures: { status: string };
            };
            assert.equal(typed.decision.overall, "not-qualified");
            assert.equal(typed.totals.planned, 4);
            assert.equal(typed.totals.completed, 4);
            assert.equal(Object.keys(typed.arms).length, 2);
            assert.ok(typed.guardrails.length >= 1);
            assert.notEqual(typed.bounds, undefined);
            assert.equal(typed.measures.status, "missing");
        } finally {
            rmSync(out, { recursive: true, force: true });
        }
    });
});
