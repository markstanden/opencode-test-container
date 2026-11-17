import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assessDocsTrial } from "../../src/evaluators/docs/assess.ts";
import type { DocsTaskCase } from "../../src/contracts/types.ts";

const KEY = "test-signing-key";

/** A docs-trigger case. */
function testCase(overrides: Partial<DocsTaskCase> = {}): DocsTaskCase {
    return {
        caseId: "docs-case",
        kind: "docs-task",
        prompt: "Write a note.",
        lakeRoot: ".",
        expectedDocs: {
            kind: "create",
            target: "notes/otel.md",
            retains: ["OpenTelemetry"],
        },
        criterion: { minVerifiedCalls: 1, verbs: ["add"] },
        ...overrides,
    };
}

/** Sign one docs journal record. */
function signed(record: Record<string, unknown>): string {
    const mac = createHmac("sha256", KEY)
        .update(JSON.stringify(record), "utf8")
        .digest("hex");
    return JSON.stringify({ ...record, mac });
}

/** An event line identifying the docs call. */
function eventLine(): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        messageID: "msg_1",
        part: {
            type: "tool",
            id: "call_1",
            tool: "docs",
            state: {
                status: "completed",
                input: { add: { mode: "create" } },
                output: "repo:notes/otel.md — created.",
            },
        },
    });
}

/** A docs call recorded in the host tool trail. */
function toolLine(input: unknown): string {
    return JSON.stringify({
        id: "call_1",
        tool: "docs",
        status: "completed",
        input,
    });
}

/** Build a trial directory with signed journal evidence. */
function trial(options: {
    entries: Array<{ input: unknown; record: Record<string, unknown> | null }>;
    files?: Record<string, string>;
    key?: string;
}): string {
    const directory = mkdtempSync(join(tmpdir(), "otc-docs-"));
    mkdirSync(join(directory, "journal"), { recursive: true });
    mkdirSync(join(directory, "workspace"), { recursive: true });
    writeFileSync(
        join(directory, "events.jsonl"),
        `${eventLine()}\n${JSON.stringify({
            type: "text",
            sessionID: "ses_1",
            messageID: "msg_2",
            part: { type: "text", text: "Written." },
        })}\n`,
        "utf8",
    );
    writeFileSync(
        join(directory, "tools.jsonl"),
        `${options.entries.map((entry) => toolLine(entry.input)).join("\n")}\n`,
        "utf8",
    );
    writeFileSync(
        join(directory, "journal", "docs-operations.jsonl"),
        `${options.entries
            .filter((entry) => entry.record !== null)
            .map((entry) => signed(entry.record as Record<string, unknown>))
            .join("\n")}\n`,
        "utf8",
    );
    writeFileSync(join(directory, "journal-key.txt"), options.key ?? KEY, {
        encoding: "utf8",
        mode: 0o600,
    });
    writeFileSync(
        join(directory, "meta.json"),
        `${JSON.stringify({ captureValid: true, captureProblems: [], exit: 0, timedOut: false })}\n`,
        "utf8",
    );
    writeFileSync(
        join(directory, "usage.json"),
        `${JSON.stringify({ inputTokens: 1, outputTokens: 1, reported: true })}\n`,
        "utf8",
    );
    for (const [path, contents] of Object.entries(options.files ?? {})) {
        const target = join(directory, "workspace", path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, "utf8");
    }
    return directory;
}

/** A completed write journal record. */
function writeRecord(
    options: {
        path?: string;
        written?: boolean;
        mode?: string;
    } = {},
): Record<string, unknown> {
    return {
        schemaVersion: 1,
        tool: "docs",
        surface: "native",
        status: "completed",
        input: { add: { mode: options.mode ?? "create" } },
        result: {
            content: "created",
            metadata: {
                written: options.written ?? true,
                lake: "repo",
                path: options.path ?? "notes/otel.md",
            },
        },
        sessionID: "ses_1",
        messageID: "msg_1",
        callID: "call_1",
    };
}

/** Assess one synthetic docs trial. */
function assess(directory: string, docsCase = testCase()) {
    return assessDocsTrial({
        campaignId: "c1",
        slotId: "s1",
        caseId: docsCase.caseId,
        armId: "a1",
        repetitionId: "r0",
        testCase: docsCase,
        trialDir: directory,
        workspace: join(directory, "workspace"),
        prepared: new Map(),
        attemptId: "deterministic-s1",
        assessedAt: "2026-01-01T00:00:00.000Z",
    });
}

describe("docs recording assessment", () => {
    it("credits a signed, attributed useful write", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# OpenTelemetry\n" },
        });
        const assessment = assess(directory);
        assert.equal(assessment.validity, "valid");
        assert.equal(assessment.outcome, "pass");
        assert.equal(assessment.counts.creditedWrites, 1);
        assert.equal(assessment.journal.state, "verified");
        rmSync(directory, { recursive: true, force: true });
    });

    it("keeps a refused write at zero recording credit", () => {
        const directory = trial({
            entries: [
                {
                    input: { add: { mode: "create" } },
                    record: writeRecord({ written: false }),
                },
            ],
        });
        const assessment = assess(
            directory,
            testCase({
                expectedDocs: { kind: "none" },
                criterion: { minVerifiedCalls: 1, verbs: ["add"] },
            }),
        );
        assert.equal(assessment.validity, "valid");
        assert.equal(assessment.outcome, "pass");
        assert.equal(assessment.counts.creditedWrites, 0);
        assert.equal(assessment.counts.attemptedWrites, 1);
        rmSync(directory, { recursive: true, force: true });
    });

    it("fails a credited write when the case expects refusal", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# OpenTelemetry\n" },
        });
        const assessment = assess(
            directory,
            testCase({ expectedDocs: { kind: "none" } }),
        );
        assert.equal(assessment.outcome, "fail");
        assert.ok(
            assessment.reasons.some((reason) =>
                reason.includes("expects refusal"),
            ),
        );
        rmSync(directory, { recursive: true, force: true });
    });

    it("refuses a tampered journal line", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# OpenTelemetry\n" },
            key: "a-different-key",
        });
        const assessment = assess(directory);
        assert.equal(assessment.validity, "invalid");
        assert.equal(assessment.outcome, "unknown");
        assert.equal(assessment.counts.creditedWrites, 0);
        assert.ok(assessment.journal.rejected > 0);
        rmSync(directory, { recursive: true, force: true });
    });

    it("fails when the written doc omits expected content", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# Something else\n" },
        });
        const assessment = assess(directory);
        assert.equal(assessment.outcome, "fail");
        assert.ok(
            assessment.reasons.some((reason) => reason.includes("retain")),
        );
        rmSync(directory, { recursive: true, force: true });
    });

    it("does not read the journal as trusted when the key is missing", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# OpenTelemetry\n" },
        });
        rmSync(join(directory, "journal-key.txt"));
        const assessment = assess(directory);
        assert.equal(assessment.validity, "invalid");
        assert.equal(assessment.journal.state, "unverifiable-key");
        assert.equal(assessment.counts.creditedCalls, 0);
        rmSync(directory, { recursive: true, force: true });
    });
});

describe("docs guardrails", () => {
    it("refuses a FIFO guardrail without hanging", () => {
        // Arrange
        const directory = trial({ entries: [] });
        try {
            assert.equal(
                spawnSync("mkfifo", [join(directory, "workspace", "pipe")])
                    .status,
                0,
            );
            const docsCase = testCase({
                expectedDocs: { kind: "none" },
                criterion: { minVerifiedCalls: 0 },
                guardrails: { unchanged: ["pipe"] },
            });

            // Act
            const assessment = assess(directory, docsCase);

            // Assert
            assert.equal(assessment.validity, "invalid");
            assert.match(
                assessment.reasons.join("; "),
                /not a regular file|special file/,
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe("docs criterion", () => {
    it("counts only the declared verbs", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "# OpenTelemetry\n" },
        });
        const assessment = assess(
            directory,
            testCase({
                criterion: { minVerifiedCalls: 1, verbs: ["search"] },
            }),
        );
        assert.equal(assessment.outcome, "fail");
        assert.ok(
            assessment.reasons.some((reason) =>
                reason.includes("below required"),
            ),
        );
        rmSync(directory, { recursive: true, force: true });
    });

    it("reads the written bytes, not a normalised answer", () => {
        const directory = trial({
            entries: [
                { input: { add: { mode: "create" } }, record: writeRecord() },
            ],
            files: { "notes/otel.md": "OpenTelemetry\n" },
        });
        const assessment = assess(directory);
        assert.equal(assessment.outcome, "pass");
        assert.equal(
            readFileSync(join(directory, "workspace", "notes/otel.md"), "utf8"),
            "OpenTelemetry\n",
        );
        rmSync(directory, { recursive: true, force: true });
    });
});
