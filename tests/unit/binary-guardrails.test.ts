import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessDocsTrial } from "../../src/evaluators/docs/assess.ts";
import { sha256Bytes } from "../../src/contracts/canonical.ts";
import type { DocsTaskCase } from "../../src/contracts/types.ts";

/** Bytes that are not valid UTF-8, so a text decode is lossy. */
const RAW = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0xc3, 0x28, 0x0a]);

/** A docs case whose guardrail protects one binary fixture. */
function testCase(): DocsTaskCase {
    return {
        caseId: "binary-guardrail",
        kind: "docs-task",
        prompt: "Leave the fixture alone.",
        lakeRoot: ".",
        expectedDocs: { kind: "none" },
        guardrails: { unchanged: ["docs/raw.bin"] },
    };
}

/** A trial whose workspace holds the exact fixture bytes. */
function trial(bytes: Buffer): string {
    const directory = mkdtempSync(join(tmpdir(), "otc-binary-"));
    mkdirSync(join(directory, "journal"), { recursive: true });
    mkdirSync(join(directory, "workspace", "docs"), { recursive: true });
    writeFileSync(
        join(directory, "events.jsonl"),
        `${JSON.stringify({
            type: "text",
            sessionID: "ses_1",
            messageID: "msg_1",
            part: { type: "text", text: "Nothing to record." },
        })}\n`,
        "utf8",
    );
    writeFileSync(join(directory, "tools.jsonl"), "", "utf8");
    writeFileSync(
        join(directory, "meta.json"),
        `${JSON.stringify({ captureValid: true, captureProblems: [], exit: 0, timedOut: false })}\n`,
        "utf8",
    );
    writeFileSync(join(directory, "workspace", "docs", "raw.bin"), bytes);
    return directory;
}

/** Assess one trial against the binary guardrail. */
function assess(directory: string) {
    return assessDocsTrial({
        campaignId: "c1",
        slotId: "s1",
        caseId: "binary-guardrail",
        armId: "a1",
        repetitionId: "r0",
        testCase: testCase(),
        trialDir: directory,
        workspace: join(directory, "workspace"),
        prepared: new Map([["docs/raw.bin", sha256Bytes(RAW)]]),
        attemptId: "deterministic-s1",
        assessedAt: "2026-01-01T00:00:00.000Z",
    });
}

describe("binary unchanged-file guardrails", () => {
    it("accepts an unmodified non-UTF-8 file", () => {
        // Arrange
        const directory = trial(RAW);
        try {
            // Act
            const assessment = assess(directory);

            // Assert
            assert.equal(
                assessment.reasons.some((reason) => /changed/.test(reason)),
                false,
                assessment.reasons.join("; "),
            );
            assert.equal(assessment.validity, "valid");
            assert.deepEqual(assessment.reasons, []);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("fails a one-byte change even when both decodings are identical", () => {
        // Arrange: two invalid bytes that both decode to U+FFFD.
        const directory = trial(
            Buffer.from([0x00, 0x81, 0xff, 0xfe, 0xc3, 0x28, 0x0a]),
        );
        try {
            // Act
            const assessment = assess(directory);

            // Assert
            assert.equal(
                assessment.reasons.some((reason) =>
                    /guardrail path docs\/raw\.bin changed/.test(reason),
                ),
                true,
                assessment.reasons.join("; "),
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("keeps a containment refusal distinct from a content difference", () => {
        // Arrange: replace the fixture with a symlink that leaves the workspace.
        const directory = trial(RAW);
        const outside = mkdtempSync(join(tmpdir(), "otc-binary-outside-"));
        try {
            rmSync(join(directory, "workspace", "docs", "raw.bin"));
            writeFileSync(join(outside, "raw.bin"), RAW);
            symlinkSync(
                join(outside, "raw.bin"),
                join(directory, "workspace", "docs", "raw.bin"),
            );

            // Act
            const assessment = assess(directory);

            // Assert
            assert.equal(
                assessment.reasons.some((problem) => /outside/.test(problem)),
                true,
                assessment.reasons.join("; "),
            );
            assert.equal(
                assessment.reasons.some((reason) => /changed/.test(reason)),
                false,
            );
            assert.equal(assessment.validity, "invalid");
        } finally {
            rmSync(directory, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});
