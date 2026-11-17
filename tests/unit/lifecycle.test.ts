import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freezeCampaign, loadFrozen } from "../../src/campaign/freeze.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { analyseCampaign } from "../../src/reporting/report.ts";
import { statusOf } from "../../src/campaign/status.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** A fake process adapter that resolves image identity and CLI version. */
const fakeImage = async (
    command: string,
    args: readonly string[],
): Promise<CommandResult> => {
    assert.equal(command, "podman");
    if (args.includes("inspect")) {
        return {
            status: 0,
            signal: null,
            stdout: `${IMAGE_ID}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    }
    return {
        status: 0,
        signal: null,
        stdout: "opencode v2.2.6\n",
        stderr: "",
        timedOut: false,
        error: null,
    };
};

/** One event line for a completed text answer. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_test",
        messageID: "msg_text",
        part: { type: "text", text },
    });
}

/** One event line for a completed skill call. */
function skillEvent(id: string, loaded = true): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: "ses_test",
        messageID: "msg_tool",
        part: {
            type: "tool",
            id: `call_${id}`,
            tool: "skill",
            state: {
                status: "completed",
                input: { id },
                output: loaded
                    ? `<skill_content name="${id}">body</skill_content>`
                    : "",
            },
        },
    });
}

/** One step-finish usage event. */
function usageEvent(): string {
    return JSON.stringify({
        type: "step_finish",
        sessionID: "ses_test",
        messageID: "msg_text",
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

/** The scripted result for a slot id. */
function streamFor(slotId: string): string {
    if (slotId === "s1") {
        return `${skillEvent("otel-helper")}\n${textEvent("Instrumented.")}\n${usageEvent()}\n`;
    }
    if (slotId === "s2") return `${textEvent("Renamed.")}\n${usageEvent()}\n`;
    return `${textEvent("No telemetry added.")}\n${usageEvent()}\n`;
}

/** Find the slot id in a container plan's title. */
function slotOf(plan: ContainerPlan): string {
    const index = plan.argv.indexOf("--title");
    const title = plan.argv[index + 1] ?? "";
    return title.slice(title.lastIndexOf("-") + 1);
}

/** Copy the fixture campaign into a disposable directory. */
function fixtureCampaign(): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-lifecycle-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return { dir, campaignPath: join(dir, "campaign.json") };
}

/** Hash every path under a root, so read-only checks are exact. */
function treeSnapshot(root: string): string {
    if (!existsSync(root)) return "missing";
    const lines: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, {
            withFileTypes: true,
        })) {
            const path = join(entry.parentPath, entry.name);
            if (entry.isDirectory()) {
                lines.push(`d ${path}`);
                walk(path);
            } else if (entry.isFile()) {
                lines.push(
                    `f ${path} ${createHash("sha256")
                        .update(readFileSync(path))
                        .digest("hex")}`,
                );
            }
        }
    };
    walk(root);
    return lines.sort().join("\n");
}

describe("campaign lifecycle", () => {
    let dir = "";
    let root = "";
    let campaignPath = "";

    before(async () => {
        const fixture = fixtureCampaign();
        dir = fixture.dir;
        campaignPath = fixture.campaignPath;
        root = join(dir, "campaign-root");
        const prepared = prepareCampaign(campaignPath, root);
        assert.equal(
            prepared.ok,
            true,
            prepared.ok ? "" : prepared.problems.join("; "),
        );
        const frozen = await freezeCampaign(
            root,
            fakeImage as typeof runCommand,
        );
        assert.equal(
            frozen.ok,
            true,
            frozen.ok ? "" : frozen.problems.join("; "),
        );
    });

    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("writes a freeze receipt with the resolved image and CLI version", () => {
        const frozen = loadFrozen(root);
        assert.equal(frozen.ok, true);
        if (!frozen.ok) return;
        assert.equal(frozen.record.imageId, IMAGE_ID);
        assert.equal(frozen.record.opencodeVersion, "2.2.6");
    });

    it("plans a dry run without writing a trial or ledger event", () => {
        const beforeRun = treeSnapshot(join(root, "evidence"));
        return runCampaign(root, { dryRun: true }).then((summary) => {
            assert.equal(summary.ok, true, summary.problems.join("; "));
            assert.deepEqual(summary.ran, ["s1", "s2", "s3"]);
            assert.equal(treeSnapshot(join(root, "evidence")), beforeRun);
        });
    });

    it("runs every slot through the injected container adapter", async () => {
        const summary = await runCampaign(
            root,
            {},
            {
                runContainer: async (plan) => ({
                    status: 0,
                    signal: null,
                    stdout: streamFor(slotOf(plan)),
                    stderr: "",
                    timedOut: false,
                    error: null,
                }),
            },
        );
        assert.equal(summary.ok, true, summary.problems.join("; "));
        assert.deepEqual(summary.ran, ["s1", "s2", "s3"]);
        assert.equal(
            existsSync(join(root, "evidence", "trials", "s1", "meta.json")),
            true,
        );
    });

    it("refuses to relaunch a started slot", async () => {
        const summary = await runCampaign(root);
        assert.equal(summary.ok, false);
        assert.deepEqual(summary.refused, ["s1", "s2", "s3"]);
        assert.ok(
            summary.problems.some((problem) =>
                problem.includes("already started"),
            ),
        );
    });

    it("assesses deterministic evidence without a judge", () => {
        const assessed = assessCampaign(root);
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        assert.equal(assessed.summary.assessed, 3);
        assert.equal(assessed.summary.pass, 3);
        assert.equal(assessed.summary.fail, 0);
    });

    it("refuses to overwrite a different assessment", () => {
        const path = join(root, "evidence", "assessments", "s2.json");
        const original = readFileSync(path, "utf8");
        writeFileSync(path, `${JSON.stringify({ drifted: true })}\n`, "utf8");
        const assessed = assessCampaign(root);
        assert.equal(assessed.ok, false);
        assert.ok(
            assessed.problems.some((problem) => problem.includes("immutable")),
        );
        writeFileSync(path, original, "utf8");
    });

    it("reports read-only status without changing the tree", () => {
        const beforeStatus = treeSnapshot(root);
        const status = statusOf(root);
        assert.equal(status.state, "assessed");
        assert.equal(status.counts.assessed, 3);
        assert.equal(treeSnapshot(root), beforeStatus);
    });

    it("refuses final analysis before closure", () => {
        const analysed = analyseCampaign(root, join(dir, "early-report"));
        assert.equal(analysed.ok, false);
        assert.ok(
            analysed.problems.some((problem) => problem.includes("close it")),
        );
    });

    it("closes idempotently", () => {
        const first = closeCampaign(root, () => "2026-01-01T00:00:00.000Z");
        assert.equal(first.ok, true);
        const second = closeCampaign(root);
        assert.equal(second.ok, true);
        if (second.ok) assert.equal(second.alreadyClosed, true);
        assert.equal(statusOf(root).state, "closed");
    });

    it("renders a final report with a valid denominator", () => {
        const out = join(dir, "final-report");
        const analysed = analyseCampaign(
            root,
            out,
            () => "2026-01-01T00:00:00.000Z",
        );
        assert.equal(
            analysed.ok,
            true,
            analysed.ok ? "" : analysed.problems.join("; "),
        );
        if (!analysed.ok) return;
        assert.equal(analysed.report.totals.pass, 3);
        assert.equal(analysed.report.denominators.valid, 3);
        assert.match(
            analysed.markdown,
            /valid denominator is pass \+ fail \(3\)/,
        );
        assert.equal(existsSync(join(out, "report.json")), true);
    });

    it("refuses a second report into the same directory", () => {
        const analysed = analyseCampaign(root, join(dir, "final-report"));
        assert.equal(analysed.ok, false);
    });

    it("refuses dispatch after closure", async () => {
        const summary = await runCampaign(root);
        assert.equal(summary.ok, false);
        assert.ok(
            summary.problems.some((problem) => problem.includes("closed")),
        );
    });
});

describe("budget refusal", () => {
    it("stops before a slot that exceeds the declared trial budget", async () => {
        const fixture = fixtureCampaign();
        const campaign = JSON.parse(
            readFileSync(fixture.campaignPath, "utf8"),
        ) as Record<string, unknown>;
        const budgets = campaign.budgets as Record<string, unknown>;
        budgets.trials = 1;
        writeFileSync(
            fixture.campaignPath,
            `${JSON.stringify(campaign, null, 2)}\n`,
            "utf8",
        );
        const root = join(fixture.dir, "campaign-root");
        const prepared = prepareCampaign(fixture.campaignPath, root);
        assert.equal(
            prepared.ok,
            true,
            prepared.ok ? "" : prepared.problems.join("; "),
        );
        const frozen = await freezeCampaign(
            root,
            fakeImage as typeof runCommand,
        );
        assert.equal(frozen.ok, true);
        const summary = await runCampaign(
            root,
            {},
            {
                runContainer: async (plan) => ({
                    status: 0,
                    signal: null,
                    stdout: streamFor(slotOf(plan)),
                    stderr: "",
                    timedOut: false,
                    error: null,
                }),
            },
        );
        assert.equal(summary.ok, false);
        assert.deepEqual(summary.ran, ["s1"]);
        assert.ok(
            summary.problems.some((problem) =>
                problem.includes("budget exhausted"),
            ),
        );
        rmSync(fixture.dir, { recursive: true, force: true });
    });
});

describe("missing evidence", () => {
    it("reports unrun rather than a passing negative", async () => {
        const fixture = fixtureCampaign();
        const root = join(fixture.dir, "campaign-root");
        const prepared = prepareCampaign(fixture.campaignPath, root);
        assert.equal(prepared.ok, true);
        const frozen = await freezeCampaign(
            root,
            fakeImage as typeof runCommand,
        );
        assert.equal(frozen.ok, true);
        const assessed = assessCampaign(root);
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        // Unrun is derived state, never a persisted terminal record: early
        // inspection must not poison a later assessment.
        assert.equal(assessed.summary.unrun, 0);
        assert.equal(assessed.summary.pass, 0);
        assert.equal(assessed.skipped.length, 3);
        assert.equal(
            existsSync(join(root, "evidence", "assessments")),
            false,
            "an unrun slot writes no assessment",
        );
        rmSync(fixture.dir, { recursive: true, force: true });
    });
});
