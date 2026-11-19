import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    reportFor,
    reportIdentity,
    reportIntact,
    reportMarkdown,
    type Report,
} from "../../src/reporting/report.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { primaryRecordFor } from "../../src/campaign/primary.ts";
import type { CommandResult } from "../../src/adapters/process.ts";

const HERE = import.meta.dirname;
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** A fake image resolver. */
const fakeImage = async (
    _command: string,
    args: readonly string[],
): Promise<CommandResult> => ({
    status: 0,
    signal: null,
    stdout: args.includes("inspect") ? `${IMAGE_ID}\n` : "opencode v2.2.6\n",
    stderr: "",
    timedOut: false,
    error: null,
});

/** One report row with explicit validity, outcome and judgement. */
function row(options: {
    slotId: string;
    validity: string;
    outcome: string;
    judged: boolean;
}): Report["slots"][number] {
    return {
        slotId: options.slotId,
        caseId: `case-${options.slotId}`,
        armId: "arm",
        repetitionId: "r0",
        expected: "activation",
        observed: options.outcome,
        validity: options.validity,
        outcome: options.outcome,
        reasons: [],
        counts: {},
        usage: null,
        usageProblems: [],
        judgement: options.judged
            ? {
                  selectedAttemptId: "attempt-001",
                  attempts: 1,
                  documentationOutcome: "useful",
                  utility: 5,
                  status: "judged",
              }
            : null,
        judgeProblems: [],
    };
}

describe("report calculation", () => {
    it("keeps unrun, invalid, unknown and unjudged denominators distinct", () => {
        // Arrange
        const slots = [
            row({ slotId: "unrun", validity: "unrun", outcome: "unknown", judged: false }),
            row({ slotId: "invalid", validity: "invalid", outcome: "unknown", judged: false }),
            row({ slotId: "unknown", validity: "unknown", outcome: "unknown", judged: false }),
            row({ slotId: "pass", validity: "valid", outcome: "pass", judged: false }),
            row({ slotId: "fail", validity: "valid", outcome: "fail", judged: true }),
        ];
        const values = {
            campaignId: "campaign",
            suiteId: "suite",
            closedAt: "2026-11-17T00:00:00.000Z",
            imageId: IMAGE_ID,
            generatedAt: "2026-11-18T00:00:00.000Z",
            assessed: 3,
            slots,
        };

        // Act
        const report = reportFor(values);

        // Assert
        assert.deepEqual(report.denominators, {
            scheduled: 5,
            assessed: 3,
            valid: 2,
            invalid: 1,
            unknown: 1,
            unrun: 1,
            judged: 1,
            unjudged: 4,
        });
        assert.deepEqual(report.totals, { pass: 1, fail: 1, unknown: 3 });
        assert.equal(reportIntact(report), true);
        assert.equal(reportIdentity(report), report.reportSha256);
    });

    it("is deep-equal and renders the same Markdown for fixed values", () => {
        // Arrange
        const values = {
            campaignId: "campaign",
            suiteId: "suite",
            closedAt: null,
            imageId: IMAGE_ID,
            generatedAt: "2026-11-18T00:00:00.000Z",
            assessed: 2,
            slots: [
                row({ slotId: "a", validity: "valid", outcome: "pass", judged: false }),
                row({ slotId: "b", validity: "unrun", outcome: "unknown", judged: false }),
            ],
        };

        // Act
        const first = reportFor(values);
        const second = reportFor({ ...values, slots: [...values.slots] });

        // Assert
        assert.deepEqual(first, second);
        assert.equal(reportMarkdown(first), reportMarkdown(second));
        assert.match(reportMarkdown(first), /Scheduled 2; assessed 2/);
        assert.match(reportMarkdown(first), /\| a \|/);
        assert.match(reportMarkdown(first), /\| b \|/);
    });
});

describe("freeze calculation", () => {
    it("produces the same receipt for fixed inputs and time", async () => {
        // Arrange
        const made: string[] = [];
        const rootOf = async (label: string): Promise<string> => {
            const dir = mkdtempSync(join(tmpdir(), `otc-freeze-${label}-`));
            made.push(dir);
            cpSync(FIXTURE, dir, { recursive: true });
            const root = join(dir, "root");
            const prepared = prepareCampaign(join(dir, "campaign.json"), root);
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            return root;
        };
        const now = () => "2026-11-19T00:00:00.000Z";
        try {
            const firstRoot = await rootOf("one");
            const secondRoot = await rootOf("two");

            // Act
            const first = await freezeCampaign(
                firstRoot,
                fakeImage as never,
                now,
            );
            const second = await freezeCampaign(
                secondRoot,
                fakeImage as never,
                now,
            );

            // Assert
            assert.equal(first.ok, true);
            assert.equal(second.ok, true);
            if (!first.ok || !second.ok) return;
            assert.deepEqual(first.record, second.record);
            assert.equal(first.record.frozenAt, now());

            // Act: a second freeze converges on the stored winner.
            const again = await freezeCampaign(
                firstRoot,
                fakeImage as never,
                () => "2026-11-20T00:00:00.000Z",
            );

            // Assert
            assert.equal(again.ok, true);
            if (!again.ok) return;
            assert.equal(again.alreadyFrozen, true);
            assert.deepEqual(again.record, first.record);
        } finally {
            for (const dir of made) rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("primary record calculation", () => {
    it("calculates the same record for fixed facts and elapsed time", () => {
        // Arrange
        const facts = {
            schemaVersion: 1 as const,
            id: "checker",
            script: "check.mjs",
            sourceHash: "a".repeat(64),
            command: "node",
            args: ["/checker/check.mjs", "/live", "/pristine"],
            timeoutMs: 1000,
            startedAt: "2026-11-19T00:00:00.000Z",
        };
        const outcome = {
            status: "fail" as const,
            exit: 1,
            signal: null,
            reason: null,
            stdout: "x".repeat(20_000),
            stderr: "y".repeat(20_000),
        };

        // Act
        const first = primaryRecordFor(facts, 42, outcome);
        const second = primaryRecordFor(facts, 42, { ...outcome });

        // Assert
        assert.deepEqual(first, second);
        assert.equal(first.durationMs, 42);
        assert.equal(first.status, "fail");
        assert.equal(first.stdout.length, 16_000);
        assert.equal(first.stderr.length, 16_000);
        for (const status of ["pass", "timeout", "error"] as const) {
            assert.equal(
                primaryRecordFor(facts, 1, { ...outcome, status }).status,
                status,
            );
        }
    });
});
