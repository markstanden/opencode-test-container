import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    captureProblems,
    decodeTrail,
    skillCalls,
    bodyRoutes,
} from "../../src/adapters/opencode/events.ts";
import { assessSkillTrial } from "../../src/evaluators/skills/assess.ts";
import type { SkillTriggerCase } from "../../src/contracts/types.ts";

/** One tool part event for a skill call. */
function skillPart(options: {
    id: string;
    status: string;
    output: string;
    callId?: string;
}): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        messageID: "msg_1",
        part: {
            type: "tool",
            id: options.callId ?? "call_1",
            tool: "skill",
            state: {
                status: options.status,
                input: { id: options.id },
                output: options.output,
            },
        },
    });
}

/** One completed answer event. */
function textPart(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_1",
        messageID: "msg_2",
        part: { type: "text", text },
    });
}

/** One usage event. */
function usagePart(): string {
    return JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1",
        messageID: "msg_2",
        part: {
            type: "step-finish",
            cost: 0.001,
            tokens: {
                input: 7,
                output: 3,
                reasoning: 1,
                cache: { read: 2, write: 1 },
            },
        },
    });
}

/** A skill-trigger case definition. */
function testCase(
    expected: "activation" | "no-activation",
    contamination?: "fail" | "record",
): SkillTriggerCase {
    return {
        caseId: "case-1",
        kind: "skill-trigger",
        targetSkillId: "otel-helper",
        expected,
        prompt: "Instrument it.",
        ...(contamination === undefined ? {} : { contamination }),
    };
}

/** Write a trial evidence directory. */
function trial(
    events: string[],
    options: { captureValid?: boolean; exit?: number } = {},
): string {
    const directory = mkdtempSync(join(tmpdir(), "otc-skill-"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "events.jsonl"),
        `${events.join("\n")}\n`,
        "utf8",
    );
    writeFileSync(
        join(directory, "meta.json"),
        `${JSON.stringify({
            captureValid: options.captureValid ?? true,
            captureProblems:
                options.captureValid === false ? ["truncated"] : [],
            exit: options.exit ?? 0,
            timedOut: false,
        })}\n`,
        "utf8",
    );
    writeFileSync(
        join(directory, "usage.json"),
        `${JSON.stringify({ inputTokens: 1, outputTokens: 1, reported: true })}\n`,
        "utf8",
    );
    return directory;
}

/** Assess one synthetic trial. */
function assess(
    directory: string,
    expected: "activation" | "no-activation",
    contamination?: "fail" | "record",
) {
    return assessSkillTrial({
        campaignId: "c1",
        slotId: "s1",
        caseId: "case-1",
        armId: "a1",
        repetitionId: "r0",
        testCase: testCase(expected, contamination),
        trialDir: directory,
        attemptId: "deterministic-s1",
        assessedAt: "2026-01-01T00:00:00.000Z",
    });
}

describe("event decoding", () => {
    it("folds repeated tool parts, text, identity and usage", () => {
        const stdout = [
            skillPart({
                id: "otel-helper",
                status: "completed",
                output: "body",
            }),
            textPart("Done."),
            usagePart(),
        ].join("\n");
        const trail = decodeTrail(stdout);
        assert.equal(trail.events, 3);
        assert.equal(trail.parseFailures, 0);
        assert.equal(trail.text, "Done.\n");
        assert.equal(trail.lastPartKind, "text");
        assert.equal(trail.calls.length, 1);
        assert.equal(trail.calls[0]?.tool, "skill");
        assert.equal(trail.usage.inputTokens, 7);
        assert.equal(trail.usage.cacheWriteTokens, 1);
        assert.equal(trail.usage.reported, true);
        assert.deepEqual(trail.sessions, ["ses_1"]);
        assert.deepEqual(trail.messages, ["msg_1", "msg_2"]);
        assert.deepEqual(captureProblems(trail), []);
    });

    it("counts malformed lines as invalid evidence", () => {
        const trail = decodeTrail("{not json}\n");
        assert.equal(trail.parseFailures, 1);
        assert.ok(
            captureProblems(trail).some((problem) =>
                problem.includes("readable JSON"),
            ),
        );
    });

    it("records target, other and failed skill calls separately", () => {
        const trail = decodeTrail(
            [
                skillPart({
                    id: "otel-helper",
                    status: "completed",
                    output: "body",
                    callId: "c1",
                }),
                skillPart({
                    id: "other",
                    status: "completed",
                    output: "other body",
                    callId: "c2",
                }),
                skillPart({
                    id: "otel-helper",
                    status: "error",
                    output: "",
                    callId: "c3",
                }),
                textPart("Done."),
            ].join("\n"),
        );
        const calls = skillCalls(trail);
        assert.equal(calls.length, 3);
        assert.equal(
            calls.filter((call) => call.requestedId === "otel-helper").length,
            2,
        );
        assert.equal(calls.filter((call) => call.loaded).length, 2);
    });

    it("detects a non-skill route to the target body", () => {
        const trail = decodeTrail(
            [
                JSON.stringify({
                    type: "tool_use",
                    part: {
                        type: "tool",
                        id: "call_read",
                        tool: "read",
                        state: {
                            status: "completed",
                            input: {
                                path: "/config-home/opencode/skills/otel-helper/SKILL.md",
                            },
                            output: "# OpenTelemetry helper",
                        },
                    },
                }),
                textPart("Read it."),
            ].join("\n"),
        );
        assert.deepEqual(bodyRoutes(trail, "otel-helper"), ["read"]);
    });
});

describe("skill assessment", () => {
    const cleanups: string[] = [];
    const make = (
        events: string[],
        options?: { captureValid?: boolean; exit?: number },
    ) => {
        const directory = trial(events, options);
        cleanups.push(directory);
        return directory;
    };

    it("passes a valid target activation", () => {
        const directory = make([
            skillPart({
                id: "otel-helper",
                status: "completed",
                output: "body",
            }),
            textPart("Instrumented."),
        ]);
        const assessment = assess(directory, "activation");
        assert.equal(assessment.validity, "valid");
        assert.equal(assessment.outcome, "pass");
        assert.equal(assessment.counts.successfulTarget, 1);
        assert.equal(assessment.answered, true);
        rmSync(directory, { recursive: true, force: true });
    });

    it("passes valid restraint with no invocation", () => {
        const directory = make([textPart("Renamed.")]);
        const assessment = assess(directory, "no-activation");
        assert.equal(assessment.validity, "valid");
        assert.equal(assessment.observed, "no-invocation");
        assert.equal(assessment.outcome, "pass");
        rmSync(directory, { recursive: true, force: true });
    });

    it("passes restraint when only another skill loaded, and counts it", () => {
        const directory = make([
            skillPart({ id: "other", status: "completed", output: "body" }),
            textPart("Used another skill."),
        ]);
        const assessment = assess(directory, "no-activation");
        assert.equal(assessment.observed, "other-skill-only");
        assert.equal(assessment.outcome, "pass");
        assert.equal(assessment.counts.otherSkill, 1);
        rmSync(directory, { recursive: true, force: true });
    });

    it("treats a failed target load as unknown, never a passing negative", () => {
        const directory = make([
            skillPart({ id: "otel-helper", status: "error", output: "" }),
            textPart("Could not load it."),
        ]);
        const assessment = assess(directory, "no-activation");
        assert.equal(assessment.validity, "unknown");
        assert.equal(assessment.outcome, "unknown");
        assert.equal(assessment.observed, "failed-target-load");
        assert.equal(assessment.counts.failedTarget, 1);
        rmSync(directory, { recursive: true, force: true });
    });

    it("treats truncated capture as invalid, not a negative", () => {
        const directory = make([textPart("Cut off")], { captureValid: false });
        const assessment = assess(directory, "no-activation");
        assert.equal(assessment.validity, "invalid");
        assert.equal(assessment.outcome, "unknown");
        rmSync(directory, { recursive: true, force: true });
    });

    it("fails a body read through another route under the fail rule", () => {
        const directory = make([
            JSON.stringify({
                type: "tool_use",
                part: {
                    type: "tool",
                    id: "call_read",
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { path: "skills/otel-helper/SKILL.md" },
                        output: "body",
                    },
                },
            }),
            textPart("Read the body."),
        ]);
        const assessment = assess(directory, "activation");
        assert.equal(assessment.validity, "invalid");
        assert.equal(assessment.contaminated, true);
        assert.deepEqual(assessment.bodyRoutes, ["read"]);
        rmSync(directory, { recursive: true, force: true });
    });
});
