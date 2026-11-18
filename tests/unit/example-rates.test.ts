import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    mergeReports,
    renderRates,
    summariseRates,
} from "../../examples/reporting/rates.mjs";

interface SlotInput {
    slotId?: string;
    caseId?: string;
    armId?: string;
    repetitionId?: string;
    expected?: string;
    observed?: string;
    validity?: string;
    outcome?: string;
}

/** One report row in the shape `otc analyse` publishes. */
function slot(overrides: SlotInput = {}) {
    return {
        slotId: `s-${Math.random().toString(16).slice(2)}`,
        caseId: "positive-instrument",
        armId: "skill-only",
        repetitionId: "r0",
        expected: "activation",
        observed: "target-activation",
        validity: "valid",
        outcome: "pass",
        ...overrides,
    };
}

/** A report carrying only the fields the rate summary reads. */
function report(slots: ReturnType<typeof slot>[]) {
    return { schemaVersion: 1, campaignId: "c", suiteId: "s", slots };
}

describe("example rate summary", () => {
    it("counts three positive activations as 3/3 activation and 3/3 pass", () => {
        const summary = summariseRates(
            report([
                slot(),
                slot({ repetitionId: "r1" }),
                slot({ repetitionId: "r2" }),
            ]),
        );

        assert.equal(summary.rows.length, 1);
        const row = summary.rows[0];
        assert.ok(row !== undefined);
        assert.equal(row.activation.count, 3);
        assert.equal(row.activation.denominator, 3);
        assert.equal(row.activation.rate, 1);
        assert.equal(row.pass.count, 3);
        assert.equal(row.pass.rate, 1);
    });

    it("counts three negative non-activations as 0/3 activation and 3/3 pass", () => {
        const negative = {
            caseId: "negative-near-miss",
            expected: "no-activation",
            observed: "no-invocation",
        };
        const summary = summariseRates(
            report([
                slot({ ...negative, repetitionId: "r0" }),
                slot({ ...negative, repetitionId: "r1" }),
                slot({ ...negative, repetitionId: "r2" }),
            ]),
        );

        const row = summary.rows[0];
        assert.ok(row !== undefined);
        assert.equal(row.activation.count, 0);
        assert.equal(row.activation.denominator, 3);
        assert.equal(row.activation.rate, 0);
        assert.equal(row.pass.count, 3);
        assert.equal(row.pass.rate, 1);
        assert.equal(row.expected, "no-activation");
    });

    it("counts three negative activations as 3/3 activation and 0/3 pass", () => {
        const summary = summariseRates(
            report([
                slot({
                    caseId: "negative-unrelated",
                    expected: "no-activation",
                    observed: "target-activation",
                    outcome: "fail",
                }),
                slot({
                    caseId: "negative-unrelated",
                    expected: "no-activation",
                    observed: "target-activation",
                    outcome: "fail",
                    repetitionId: "r1",
                }),
                slot({
                    caseId: "negative-unrelated",
                    expected: "no-activation",
                    observed: "target-activation",
                    outcome: "fail",
                    repetitionId: "r2",
                }),
            ]),
        );

        const row = summary.rows[0];
        assert.ok(row !== undefined);
        assert.equal(row.activation.count, 3);
        assert.equal(row.activation.rate, 1);
        assert.equal(row.pass.count, 0);
        assert.equal(row.pass.rate, 0);
    });

    it("keeps only valid rows in the denominator and reports every exclusion", () => {
        const summary = summariseRates(
            report([
                slot({ repetitionId: "r0" }),
                slot({
                    repetitionId: "r1",
                    observed: "no-invocation",
                    outcome: "fail",
                }),
                slot({
                    repetitionId: "r2",
                    validity: "invalid",
                    outcome: "unknown",
                }),
                slot({
                    repetitionId: "r3",
                    validity: "unknown",
                    observed: "failed-target-load",
                    outcome: "unknown",
                }),
                slot({
                    repetitionId: "r4",
                    validity: "unrun",
                    observed: "unrun",
                    outcome: "unknown",
                }),
            ]),
        );

        const row = summary.rows[0];
        assert.ok(row !== undefined);
        assert.equal(row.scheduled, 5);
        assert.equal(row.valid, 2);
        assert.equal(row.activation.count, 1);
        assert.equal(row.activation.denominator, 2);
        assert.equal(row.pass.count, 1);
        assert.equal(row.pass.denominator, 2);
        assert.deepEqual(row.excluded, { invalid: 1, unknown: 1, unrun: 1 });
    });

    it("renders a zero denominator as unavailable, never as 0%", () => {
        const summary = summariseRates(
            report([slot({ validity: "invalid", outcome: "unknown" })]),
        );
        const row = summary.rows[0];
        assert.ok(row !== undefined);
        assert.equal(row.activation.rate, null);
        assert.equal(row.pass.rate, null);
        const rendered = renderRates(summary);
        assert.match(rendered, /unavailable/);
        assert.doesNotMatch(rendered, /0%/);
        assert.doesNotMatch(rendered, /NaN|Infinity/);
    });

    it("keeps the same case in two arms as separate rows", () => {
        const summary = summariseRates(
            report([
                slot({ armId: "before" }),
                slot({ armId: "after" }),
                slot({ armId: "after", repetitionId: "r1" }),
            ]),
        );

        assert.equal(summary.rows.length, 2);
        const before = summary.rows.find((row) => row.armId === "before");
        const after = summary.rows.find((row) => row.armId === "after");
        assert.equal(before?.valid, 1);
        assert.equal(after?.valid, 2);
    });

    it("reports an explicit control separately from treatment rows", () => {
        const summary = summariseRates(
            report([
                slot(),
                slot({
                    caseId: "explicit-invocation",
                    repetitionId: "r0",
                }),
            ]),
            { controls: ["explicit-invocation"] },
        );

        assert.deepEqual(
            summary.rows.map((row) => row.caseId),
            ["positive-instrument"],
        );
        assert.deepEqual(
            summary.controls.map((row) => row.caseId),
            ["explicit-invocation"],
        );
        assert.equal(summary.controls[0]?.control, true);
        assert.match(renderRates(summary), /control/i);
    });
});

describe("sharded report merge", () => {
    /** The nine-slot shipped schedule with a shard's slice executed. */
    function shard(
        executed: ReadonlyMap<string, SlotInput>,
    ): ReturnType<typeof report> {
        const ids = [
            "pos-r0",
            "pos-r1",
            "pos-r2",
            "neg-r0",
            "neg-r1",
            "neg-r2",
            "near-r0",
            "near-r1",
            "near-r2",
        ];
        return report(
            ids.map((slotId) =>
                executed.has(slotId)
                    ? slot({ slotId, ...executed.get(slotId) })
                    : slot({
                          slotId,
                          validity: "unrun",
                          observed: "unrun",
                          outcome: "unknown",
                      }),
            ),
        );
    }

    const positive = { observed: "target-activation", outcome: "pass" };
    const negative = { observed: "no-invocation", outcome: "pass" };

    it("reconciles unrun rows across shards into the frozen denominator", () => {
        // Arrange: the documented 3 + 6 split. Each report still lists all
        // nine scheduled slots; only one root executed each slot.
        const first = shard(
            new Map([
                ["pos-r0", positive],
                ["neg-r0", negative],
                ["near-r0", negative],
            ]),
        );
        const second = shard(
            new Map([
                ["pos-r1", positive],
                ["pos-r2", positive],
                ["neg-r1", negative],
                ["neg-r2", negative],
                ["near-r1", negative],
                ["near-r2", negative],
            ]),
        );

        // Act
        const merged = mergeReports([first, second]);
        const summary = summariseRates(merged);

        // Assert
        assert.equal(first.slots.length, 9);
        assert.equal(second.slots.length, 9);
        assert.equal(merged.slots?.length, 9);
        assert.equal(
            new Set(merged.slots?.map((slot) => slot.slotId)).size,
            9,
        );
        assert.equal(
            summary.rows.reduce((sum, row) => sum + row.scheduled, 0),
            9,
        );
        assert.equal(
            summary.rows.reduce((sum, row) => sum + row.valid, 0),
            9,
        );
    });

    it("refuses two actual executions of the same slot", () => {
        // Arrange: both roots ran pos-r0.
        const first = shard(new Map([["pos-r0", positive]]));
        const second = shard(new Map([["pos-r0", negative]]));

        // Act / Assert
        assert.throws(
            () => mergeReports([first, second]),
            /slot pos-r0 was executed in more than one shard/,
        );
    });

    it("preserves a slot that no shard ran", () => {
        // Arrange: pos-r0 unrun in both reports.
        const first = shard(new Map());
        const second = shard(new Map());

        // Act
        const merged = mergeReports([first, second]);

        // Assert
        const orphan = merged.slots?.filter(
            (slot) => slot.slotId === "pos-r0",
        );
        assert.equal(orphan?.length, 1);
        assert.equal(orphan?.[0]?.validity, "unrun");
    });

    it("refuses shards from different campaigns", () => {
        // Arrange
        const other = { ...report([slot({ slotId: "b" })]), campaignId: "x" };

        // Act / Assert
        assert.throws(
            () => mergeReports([report([slot({ slotId: "a" })]), other]),
            /different campaigns/,
        );
    });
});
