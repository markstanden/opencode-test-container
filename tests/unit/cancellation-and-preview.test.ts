import { describe, it } from "node:test";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { readClaims } from "../../src/campaign/budget.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"1".repeat(64)}`;

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

/** One completed text event. */
function textEvent(): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_cancel",
        messageID: "msg_cancel",
        part: { type: "text", text: "No activation." },
    });
}

/** The trial result one slot returns. */
function result(): CommandResult {
    return {
        status: 0,
        signal: null,
        stdout: `${textEvent()}\n`,
        stderr: "",
        timedOut: false,
        error: null,
    };
}

/** Prepare and freeze the skills fixture, optionally with one trial budget. */
async function campaignRoot(options: { trials?: number } = {}): Promise<{
    dir: string;
    root: string;
}> {
    const dir = mkdtempSync(join(tmpdir(), "otc-cancel-"));
    cpSync(FIXTURE, dir, { recursive: true });
    if (options.trials !== undefined) {
        const path = join(dir, "campaign.json");
        const campaign = JSON.parse(readFileSync(path, "utf8")) as {
            budgets: { trials: number };
        };
        campaign.budgets.trials = options.trials;
        writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
    }
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

describe("cancellation boundaries", () => {
    it("spawns nothing for an already-aborted signal", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        const controller = new AbortController();
        controller.abort();
        const plans: ContainerPlan[] = [];
        try {
            // Act
            const summary = await runCampaign(
                root,
                { signal: controller.signal },
                {
                    runContainer: async (plan) => {
                        plans.push(plan);
                        return result();
                    },
                },
            );

            // Assert
            assert.equal(summary.ok, false);
            assert.match(
                summary.problems.join("; "),
                /cancelled before any dispatch/,
            );
            assert.equal(plans.length, 0);
            assert.deepEqual(readClaims(join(root, "evidence"), "trial"), []);
            assert.deepEqual(readLedger(root).events, []);
            assert.deepEqual(
                existsSync(join(root, "evidence", "trials")),
                false,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("starts no later slot when the first slot is cancelled", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        const controller = new AbortController();
        const plans: ContainerPlan[] = [];
        try {
            // Act
            const summary = await runCampaign(
                root,
                { signal: controller.signal },
                {
                    runContainer: async (plan) => {
                        plans.push(plan);
                        // The first dispatch is in flight; cancelling must not
                        // start slot two or three.
                        controller.abort();
                        return result();
                    },
                },
            );

            // Assert
            assert.equal(plans.length, 1);
            assert.equal(plans[0]?.signal, controller.signal);
            assert.notEqual(plans[0]?.name, undefined);
            assert.deepEqual(summary.ran, ["s1"]);
            assert.match(
                summary.problems.join("; "),
                /cancelled before slot s2/,
            );
            const claims = readClaims(join(root, "evidence"), "trial");
            assert.equal(claims.length, 1);
            assert.equal(claims[0]?.state, "closed");
            assert.deepEqual(readdirSync(join(root, "evidence", "trials")), [
                "s1",
            ]);
            assert.equal(
                existsSync(join(root, "evidence", "trials", "s2")),
                false,
            );
            assert.equal(
                readLedger(root).events.filter(
                    (event) => event.event === "trial-start",
                ).length,
                1,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("budget preview", () => {
    it("reports one admissible slot and the remaining refusals without claiming", async () => {
        // Arrange
        const { dir, root } = await campaignRoot({ trials: 1 });
        try {
            // Act
            const summary = await runCampaign(root, { dryRun: true });

            // Assert
            assert.equal(summary.ok, true, summary.problems.join("; "));
            assert.deepEqual(summary.ran, ["s1"]);
            assert.deepEqual(summary.refused, ["s2", "s3"]);
            assert.deepEqual(
                summary.preview?.map((entry) => [
                    entry.slotId,
                    entry.admissible,
                    entry.reason.startsWith("budget:"),
                ]),
                [
                    ["s1", true, false],
                    ["s2", false, true],
                    ["s3", false, true],
                ],
            );
            assert.deepEqual(readClaims(join(root, "evidence"), "trial"), []);
            assert.equal(existsSync(join(root, "evidence", "trials")), false);
            assert.deepEqual(readLedger(root).events, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("distinguishes staging invalidity from budget availability", async () => {
        // Arrange: planning refuses a value Podman could not carry, which is
        // a staging problem, not a budget one.
        const { dir, root } = await campaignRoot({ trials: 3 });
        process.env.OTC_PREVIEW_TOKEN = "line\nbreak";
        try {
            // Act
            const summary = await runCampaign(root, {
                dryRun: true,
                passthrough: ["OTC_PREVIEW_TOKEN"],
            });

            // Assert
            assert.equal(summary.ok, false);
            assert.match(summary.problems.join("; "), /OTC_PREVIEW_TOKEN/);
            const first = summary.preview?.[0];
            assert.equal(first?.admissible, false);
            assert.match(first?.reason ?? "", /^staging:/);
            assert.deepEqual(readClaims(join(root, "evidence"), "trial"), []);
        } finally {
            delete process.env.OTC_PREVIEW_TOKEN;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lets concurrent runners respect the durable ceiling", async () => {
        // Arrange
        const { dir, root } = await campaignRoot({ trials: 1 });
        let calls = 0;
        try {
            // Act: both see an unclaimed budget before either claims.
            const summaries = await Promise.all([
                runCampaign(
                    root,
                    {},
                    {
                        runContainer: async () => {
                            calls += 1;
                            return result();
                        },
                    },
                ),
                runCampaign(
                    root,
                    {},
                    {
                        runContainer: async () => {
                            calls += 1;
                            return result();
                        },
                    },
                ),
            ]);

            // Assert
            assert.equal(calls, 1);
            assert.equal(
                summaries.reduce((sum, one) => sum + one.ran.length, 0),
                1,
            );
            const claims = readClaims(join(root, "evidence"), "trial");
            assert.equal(claims.length, 1);
            assert.equal(claims[0]?.state, "closed");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
