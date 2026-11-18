import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { judgeCampaign } from "../../src/campaign/judge.ts";
import { analyseCampaign } from "../../src/reporting/report.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";
import {
    docsCallEvent,
    textEvent,
    validJudgement,
    writeJournal,
} from "../support/docs-trial.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "..", "fixtures", "skill-basic");
const DOCS = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"3".repeat(64)}`;

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

/** A complete step-finish usage event. */
function usageEvent(): string {
    return JSON.stringify({
        type: "step_finish",
        sessionID: "ses_test",
        messageID: "msg_test",
        part: {
            type: "step-finish",
            cost: 0,
            tokens: {
                input: 10,
                output: 2,
                reasoning: 0,
                cache: { read: 1, write: 0 },
            },
        },
    });
}

/** The mount source for one container target. */
function mountSource(plan: ContainerPlan, target: string): string {
    const mount = plan.mounts.find((entry) => entry.target === target);
    assert.notEqual(mount, undefined);
    return (mount as { source: string }).source;
}

/** A scripted skill trial with measured usage. */
function skills(): (plan: ContainerPlan) => Promise<CommandResult> {
    return async (_plan) => ({
        status: 0,
        signal: null,
        stdout: `${textEvent("No activation.")}\n${usageEvent()}\n`,
        stderr: "",
        timedOut: false,
        error: null,
    });
}

/** A scripted docs trial with measured usage and a valid journal. */
function docs(): (plan: ContainerPlan) => Promise<CommandResult> {
    return async (plan) => {
        if (plan.argv[0] === "node") {
            return {
                status: 0,
                signal: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        const slot = plan.labels?.["otc.slot"] ?? "";
        if (plan.mounts.some((mount) => mount.target === "/judge/packet.md")) {
            return {
                status: 0,
                signal: null,
                stdout: `${textEvent(validJudgement(slot))}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        if (slot === "useful-write") {
            writeJournal(plan);
            const workspace = mountSource(plan, "/workspace");
            mkdirSync(join(workspace, "docs", "notes"), { recursive: true });
            writeFileSync(
                join(workspace, "docs", "notes", "otel.md"),
                "# OpenTelemetry\n\nName spans after the operation.\n",
                "utf8",
            );
        }
        return {
            status: 0,
            signal: null,
            stdout: `${
                slot === "useful-write" ? `${docsCallEvent()}\n` : ""
            }${textEvent("Recorded the convention.")}\n${usageEvent()}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** A closed campaign root for one fixture. */
async function closedRoot(
    fixture: string,
    container: (plan: ContainerPlan) => Promise<CommandResult>,
    judged = false,
): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-usage-"));
    cpSync(fixture, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    const ran = await runCampaign(root, {}, { runContainer: container });
    assert.equal(ran.ok, true, ran.problems.join("; "));
    const assessed = assessCampaign(root);
    assert.equal(assessed.ok, true, assessed.problems.join("; "));
    if (judged) {
        const judgedResult = await judgeCampaign(root, {}, {
            runContainer: container,
        });
        assert.equal(
            judgedResult.ok,
            true,
            judgedResult.problems.join("; "),
        );
    }
    const closed = closeCampaign(root);
    assert.equal(closed.ok, true, closed.ok ? "" : closed.problems.join("; "));
    return { dir, root };
}

/** One slot's usage from a fresh report. */
function reportUsage(root: string, dir: string): {
    usage: unknown;
    problems: string[];
} {
    const out = join(dir, `report-${String(Math.random()).slice(2)}`);
    const report = analyseCampaign(root, out);
    if (!report.ok) throw new Error(report.problems.join("; "));
    const slot = report.report.slots[0];
    assert.notEqual(slot, undefined);
    return {
        usage: slot?.usage ?? null,
        problems: slot?.usageProblems ?? [],
    };
}

describe("closed report usage identity", () => {
    it("accepts measured usage for a skill campaign", async () => {
        // Arrange
        const { dir, root } = await closedRoot(SKILLS, skills());
        try {
            // Act
            const usage = reportUsage(root, dir);

            // Assert
            assert.equal(usage.problems.length, 0);
            assert.equal(
                (usage.usage as { inputTokens?: number } | null)?.inputTokens,
                10,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses to accept changed usage after closure", async () => {
        // Arrange
        const { dir, root } = await closedRoot(SKILLS, skills());
        try {
            writeFileSync(
                join(
                    root,
                    "evidence",
                    "trials",
                    "s1",
                    "usage.json",
                ),
                `${JSON.stringify({ inputTokens: 999, outputTokens: 999, reported: true })}\n`,
                "utf8",
            );

            // Act
            const usage = reportUsage(root, dir);

            // Assert
            assert.equal(usage.usage, null);
            assert.match(usage.problems.join("; "), /bound identity/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses to accept lost usage after closure", async () => {
        // Arrange
        const { dir, root } = await closedRoot(SKILLS, skills());
        try {
            rmSync(join(root, "evidence", "trials", "s1", "usage.json"));

            // Act
            const usage = reportUsage(root, dir);

            // Assert
            assert.equal(usage.usage, null);
            assert.match(usage.problems.join("; "), /missing/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("verifies docs evaluator usage too", async () => {
        // Arrange
        const { dir, root } = await closedRoot(DOCS, docs(), true);
        try {
            writeFileSync(
                join(
                    root,
                    "evidence",
                    "trials",
                    "useful-write",
                    "usage.json",
                ),
                `${JSON.stringify({ inputTokens: 7, outputTokens: 7, reported: true })}\n`,
                "utf8",
            );

            // Act
            const usage = reportUsage(root, dir);

            // Assert
            assert.equal(usage.usage, null);
            assert.match(usage.problems.join("; "), /bound identity/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
