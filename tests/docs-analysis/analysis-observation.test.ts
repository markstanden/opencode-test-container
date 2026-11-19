import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../../src/contracts/canonical.ts";
import {
    newTrace,
    runAnalysis,
    traceObservation,
    type ConsumedInput,
} from "../../src/evaluators/docs/analysis/replay.ts";

const HERE = import.meta.dirname;
const MANIFEST = join(
    HERE,
    "..",
    "fixtures",
    "docs-analysis",
    "manifests",
    "mini.json",
);
const CORPUS = join(HERE, "..", "fixtures", "docs-analysis", "mini-corpus");
const PARITY = join(HERE, "..", "fixtures", "docs-parity");

/** A disposable corpus and manifest. */
function workspace(): {
    dir: string;
    manifest: string;
    evidence: string;
    out: (name: string) => string;
} {
    const dir = mkdtempSync(join(tmpdir(), "otc-observation-"));
    const evidence = join(dir, "evidence");
    cpSync(CORPUS, evidence, { recursive: true });
    const manifest = join(dir, "campaign.json");
    cpSync(MANIFEST, manifest);
    return {
        dir,
        manifest,
        evidence,
        out: (name) => join(dir, name),
    };
}

/** The receipt shape this module publishes. */
interface Receipt {
    renderedAt: string;
    manifestSha256: string;
    inputs: Array<{
        reference: string;
        kind: string;
        sha256: string | null;
        state: string;
    }>;
}

/** Read one JSON document. */
const json = <T>(path: string): T =>
    JSON.parse(readFileSync(path, "utf8")) as T;

describe("analysis replay observations", () => {
    it("binds the receipt to the manifest bytes that were parsed", () => {
        // Arrange
        const space = workspace();
        const original = readFileSync(space.manifest, "utf8");
        const changed = original.replace(
            '"mini-20261111"',
            '"mini-substituted"',
        );
        let reads = 0;
        try {
            // Act: a second, different source is offered but never read.
            const run = runAnalysis(
                [
                    "--campaign",
                    space.manifest,
                    "--evidence-root",
                    space.evidence,
                    "--out",
                    space.out("out"),
                ],
                {
                    now: () => "2026-11-19T00:00:00.000Z",
                    readManifest: () => {
                        reads += 1;
                        return reads === 1 ? original : changed;
                    },
                },
            );

            // Assert
            assert.equal(run.status, 0, run.messages.join("; "));
            assert.equal(reads, 1);
            const receipt = json<Receipt>(
                join(space.out("out"), "analysis-receipt.json"),
            );
            assert.equal(
                receipt.manifestSha256,
                sha256Bytes(Buffer.from(original)),
            );
            assert.equal(receipt.inputs[0]?.reference, "campaign-manifest");
            assert.equal(
                receipt.inputs[0]?.sha256,
                sha256Bytes(Buffer.from(original)),
            );
            assert.equal(receipt.renderedAt, "2026-11-19T00:00:00.000Z");
            const analysis = json<{ campaign: { id: string } }>(
                join(space.out("out"), "analysis.json"),
            );
            assert.equal(analysis.campaign.id, "mini-20261111");
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("publishes the same receipt and analysis for fixed inputs and time", () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-observation-fixed-"));
        const now = () => "2026-11-19T00:00:00.000Z";
        const args = (out: string): string[] => [
            "--campaign",
            join(PARITY, "manifest.json"),
            "--evidence-root",
            join(PARITY, "evidence"),
            "--out",
            out,
        ];
        try {
            // Act
            const first = runAnalysis(args(join(dir, "one")), { now });
            const second = runAnalysis(args(join(dir, "two")), { now });

            // Assert
            assert.equal(first.status, 0, first.messages.join("; "));
            assert.equal(second.status, 0, second.messages.join("; "));
            for (const name of [
                "analysis.json",
                "REPORT.md",
                "SCREENING.json",
                "analysis-receipt.json",
            ]) {
                assert.equal(
                    readFileSync(join(dir, "one", name), "utf8"),
                    readFileSync(join(dir, "two", name), "utf8"),
                    name,
                );
            }
            const receipt = json<Receipt>(
                join(dir, "one", "analysis-receipt.json"),
            );
            assert.equal(receipt.renderedAt, now());
            assert.deepEqual(
                receipt.inputs,
                json<Receipt>(join(PARITY, "expected", "analysis-receipt.json"))
                    .inputs,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps equivalent repeat observations and records conflicts without replacing them", () => {
        // Arrange
        const trace = newTrace();
        const first: ConsumedInput = {
            reference: "a/lake",
            kind: "directory",
            sha256: "a".repeat(64),
            state: "available",
        };
        const equivalent: ConsumedInput = { ...first };
        const conflicting: ConsumedInput = {
            ...first,
            sha256: "b".repeat(64),
        };

        // Act
        traceObservation(trace, first);
        traceObservation(trace, equivalent);
        traceObservation(trace, conflicting);

        // Assert: one entry, the first observation, and one conflict.
        assert.equal(trace.observations.size, 1);
        assert.equal(trace.conflicts.length, 1);
        assert.match(trace.conflicts[0] ?? "", /a\/lake changed/);
        assert.equal(
            trace.observations.get("directory\u0000a/lake")?.sha256,
            first.sha256,
        );
    });

    it("keeps a missing directory distinct from a same-kind available one", () => {
        // Arrange
        const trace = newTrace();
        const missing: ConsumedInput = {
            reference: "a/lake",
            kind: "directory",
            sha256: null,
            state: "missing",
        };
        const empty: ConsumedInput = {
            reference: "a/lake",
            kind: "directory",
            sha256: sha256Bytes("[]"),
            state: "available",
        };

        // Act
        traceObservation(trace, missing);
        traceObservation(trace, empty);

        // Assert
        assert.equal(trace.observations.size, 1);
        assert.equal(trace.conflicts.length, 1);
        assert.equal(
            trace.observations.get("directory\u0000a/lake")?.state,
            "missing",
        );
    });
});
