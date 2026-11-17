import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCapture } from "../../src/evidence/capture.ts";
import { decodeTrail } from "../../src/adapters/opencode/events.ts";
import { sha256Bytes } from "../../src/contracts/canonical.ts";
import { assessSkillTrial } from "../../src/evaluators/skills/assess.ts";
import { assessDocsTrial } from "../../src/evaluators/docs/assess.ts";
import type { DocsTaskCase, SkillTriggerCase } from "../../src/contracts/types.ts";

/** One completed answer event. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_capture",
        messageID: "msg_capture",
        part: { type: "text", text },
    });
}

/** A trial directory with raw capture and consistent metadata. */
function trial(
    options: {
        raw?: string;
        meta?: Record<string, unknown>;
        answer?: string | null;
    } = {},
): string {
    const dir = mkdtempSync(join(tmpdir(), "otc-capture-"));
    const raw = options.raw ?? `${textEvent("Done.")}\n`;
    const trail = decodeTrail(raw);
    const meta = {
        campaignId: "campaign",
        slotId: "slot",
        captureValid: true,
        captureProblems: [],
        exit: 0,
        timedOut: false,
        error: null,
        overflowed: false,
        events: trail.events,
        parseFailures: trail.parseFailures,
        textParts: trail.textParts,
        lastPartKind: trail.lastPartKind,
        answerSha256: sha256Bytes(trail.text),
        ...options.meta,
    };
    writeFileSync(join(dir, "events.jsonl"), raw, "utf8");
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
    const answer = options.answer === undefined ? trail.text : options.answer;
    if (answer !== null) writeFileSync(join(dir, "answer.md"), answer, "utf8");
    return dir;
}

const skillCase: SkillTriggerCase = {
    caseId: "slot",
    kind: "skill-trigger",
    targetSkillId: "otel-helper",
    expected: "no-activation",
    prompt: "Do nothing.",
};

const docsCase: DocsTaskCase = {
    caseId: "slot",
    kind: "docs-task",
    prompt: "Do nothing.",
    lakeRoot: "docs",
    expectedDocs: { kind: "none" },
    criterion: { minVerifiedCalls: 0 },
};

describe("checked capture", () => {
    const dirs: string[] = [];
    const checked = (dir: string) => {
        dirs.push(dir);
        return checkCapture(dir, { campaignId: "campaign", slotId: "slot" });
    };
    const clean = (dir: string) => rmSync(dir, { recursive: true, force: true });

    it("accepts a valid zero-tool-call completion", () => {
        // Arrange
        const dir = trial();

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "valid");
        assert.equal(capture.trail?.calls.length, 0);
    });

    it("rejects a malformed JSON line", () => {
        // Arrange
        const dir = trial({ raw: `not json\n${textEvent("Done.")}\n` });

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "invalid");
        assert.match(capture.problems.join("; "), /not readable JSON/);
    });

    it("rejects a truncated final event", () => {
        // Arrange
        const line = textEvent("Done.");
        const dir = trial({ raw: `${line.slice(0, -10)}\n` });

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "invalid");
    });

    it("rejects an empty stream", () => {
        // Arrange
        const dir = trial({ raw: "" });

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "invalid");
        assert.match(capture.problems.join("; "), /no events/);
    });

    it("rejects a stream that ends on a tool part", () => {
        // Arrange
        const dir = trial({
            raw: JSON.stringify({
                type: "tool_use",
                part: { type: "tool", id: "call_1", tool: "skill", state: {} },
            }),
        });

        // Act / Assert
        assert.match(checked(dir).problems.join("; "), /did not end on an answer/);
    });

    it("rejects a false validity flag even when its problem list is empty", () => {
        // Arrange
        const dir = trial({
            meta: { captureValid: false, captureProblems: [] },
        });

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "invalid");
        assert.match(capture.problems.join("; "), /without a reason/);
    });

    it("rejects a true validity flag over malformed raw content", () => {
        // Arrange
        const dir = trial({
            raw: `broken\n${textEvent("Done.")}\n`,
            meta: { captureValid: true, captureProblems: [], parseFailures: 0 },
        });

        // Act
        const capture = checked(dir);

        // Assert
        assert.equal(capture.state, "invalid");
        assert.match(capture.problems.join("; "), /does not describe|not readable/);
    });

    it("rejects non-zero exit, timeout and overflow even with readable text", () => {
        // Arrange
        const exits = trial({ meta: { exit: 3 } });
        const timedOut = trial({ meta: { timedOut: true } });
        const overflowed = trial({ meta: { overflowed: true } });

        // Act / Assert
        assert.match(checked(exits).problems.join("; "), /exited 3/);
        assert.match(checked(timedOut).problems.join("; "), /timed out/);
        assert.match(checked(overflowed).problems.join("; "), /byte limit/);
    });

    it("rejects a missing raw capture and a missing answer bound by metadata", () => {
        // Arrange
        const noEvents = trial();
        rmSync(join(noEvents, "events.jsonl"));
        const noAnswer = trial({ answer: null });

        // Act / Assert
        assert.match(checked(noEvents).problems.join("; "), /event stream is missing/);
        assert.match(checked(noAnswer).problems.join("; "), /answer record is missing/);
    });

    it("rejects an answer that does not match the raw capture", () => {
        // Arrange
        const dir = trial({ answer: "different\n" });

        // Act / Assert
        assert.match(
            checked(dir).problems.join("; "),
            /answer record does not match/,
        );
    });

    it("agrees across skills and docs on the same invalid capture", () => {
        // Arrange
        const dir = trial({
            raw: `broken\n${textEvent("Done.")}\n`,
            meta: { captureValid: false, captureProblems: [] },
        });
        dirs.push(dir);

        // Act
        const skills = assessSkillTrial({
            campaignId: "campaign",
            slotId: "slot",
            caseId: "slot",
            armId: "arm",
            repetitionId: "r0",
            testCase: skillCase,
            trialDir: dir,
            attemptId: "deterministic-slot",
            assessedAt: "2026-11-17T00:00:00.000Z",
        });
        const docs = assessDocsTrial({
            campaignId: "campaign",
            slotId: "slot",
            caseId: "slot",
            armId: "arm",
            repetitionId: "r0",
            testCase: docsCase,
            trialDir: dir,
            workspace: join(dir, "workspace"),
            prepared: new Map(),
            attemptId: "deterministic-slot",
            assessedAt: "2026-11-17T00:00:00.000Z",
        });

        // Assert
        assert.equal(skills.validity, "invalid");
        assert.equal(docs.validity, "invalid");
        const captureReason = "metadata declared an invalid capture without a reason";
        assert.ok(skills.reasons.includes(captureReason));
        assert.ok(docs.reasons.includes(captureReason));
    });

    it("reports a missing trial as unrun, not invalid", () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-capture-empty-"));
        dirs.push(dir);

        // Act
        const capture = checkCapture(dir);

        // Assert
        assert.equal(capture.state, "unrun");
    });

    after(() => {
        for (const dir of dirs) clean(dir);
    });
});
