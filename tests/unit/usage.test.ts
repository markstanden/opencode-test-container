import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeTrail } from "../../src/adapters/opencode/events.ts";

/** One step-finish event with the supplied token block. */
function stepFinish(part: Record<string, unknown>): string {
    return JSON.stringify({
        type: "step_finish",
        sessionID: "ses_usage",
        messageID: "msg_usage",
        part: { type: "step-finish", ...part },
    });
}

/** Decode one usage stream. */
function usage(...lines: string[]) {
    return decodeTrail(`${lines.join("\n")}\n`).usage;
}

describe("usage coverage", () => {
    it("reports no usage as unknown, not measured zero", () => {
        // Act
        const observed = usage();

        // Assert
        assert.equal(observed.reported, false);
        assert.equal(observed.inputTokens, 0);
        assert.deepEqual(observed.coverage, {
            tokens: "unknown",
            cost: "unknown",
        });
    });

    it("treats explicit zeros as measured", () => {
        // Act
        const observed = usage(
            stepFinish({
                cost: 0,
                tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            }),
        );

        // Assert
        assert.deepEqual(observed.coverage, {
            tokens: "measured",
            cost: "measured",
        });
        assert.equal(observed.inputTokens, 0);
    });

    it("reports partial token fields as partial", () => {
        // Act
        const observed = usage(
            stepFinish({
                cost: 0.1,
                tokens: {
                    input: 5,
                    output: 2,
                    reasoning: 1,
                    cache: { read: 1 },
                },
            }),
        );

        // Assert
        assert.equal(observed.coverage.tokens, "partial");
        assert.equal(observed.coverage.cost, "measured");
    });

    it("stays partial when one of several events is incomplete", () => {
        // Act
        const observed = usage(
            stepFinish({
                cost: 0.1,
                tokens: {
                    input: 5,
                    output: 2,
                    reasoning: 1,
                    cache: { read: 1, write: 1 },
                },
            }),
            stepFinish({ cost: 0.2, tokens: { input: 1, output: 1 } }),
        );

        // Assert
        assert.equal(observed.coverage.tokens, "partial");
        assert.equal(observed.coverage.cost, "measured");
        assert.equal(observed.steps, 2);
    });

    it("marks a missing cost as partial even after a measured event", () => {
        // Act
        const observed = usage(
            stepFinish({
                cost: 0.1,
                tokens: {
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            }),
            stepFinish({
                tokens: {
                    input: 1,
                    output: 1,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                },
            }),
        );

        // Assert
        assert.equal(observed.coverage.cost, "partial");
    });
});
