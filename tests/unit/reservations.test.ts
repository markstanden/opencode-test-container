import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign, trialDirectory } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { statusOf } from "../../src/campaign/status.ts";
import {
    advanceClaim,
    claimBudget,
    readClaims,
    releaseClaim,
} from "../../src/evaluators/docs/analysis/budget.ts";
import { appendLedgerEvent } from "../../src/campaign/ledger.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const RUN_MODULE = pathToFileURL(
    join(HERE, "..", "..", "src", "campaign", "run.ts"),
).href;
const IMAGE_ID = `sha256:${"1".repeat(64)}`;

const fakeImage = async (
    command: string,
    args: readonly string[],
): Promise<CommandResult> => {
    assert.equal(command, "podman");
    return args.includes("inspect")
        ? {
              status: 0,
              signal: null,
              stdout: `${IMAGE_ID}\n`,
              stderr: "",
              timedOut: false,
              error: null,
          }
        : {
              status: 0,
              signal: null,
              stdout: "opencode v2.2.6\n",
              stderr: "",
              timedOut: false,
              error: null,
          };
};

/** A prepared and frozen root with a chosen trial budget. */
async function root(budget = 3): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-reservations-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const campaignPath = join(dir, "campaign.json");
    const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
        budgets: { trials: number };
    };
    campaign.budgets.trials = budget;
    writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    const rootPath = join(dir, "root");
    const prepared = prepareCampaign(campaignPath, rootPath);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(rootPath, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root: rootPath };
}

/** One valid text-only capture. */
function stdout(): string {
    return `${JSON.stringify({
        type: "text",
        sessionID: "ses_race",
        messageID: "msg_race",
        part: { type: "text", text: "Done." },
    })}\n`;
}

/** The in-process scripted container, appending one dispatch receipt. */
function scripted(log: string) {
    return async (_plan: ContainerPlan): Promise<CommandResult> => {
        appendFileSync(log, "dispatch\n", "utf8");
        return {
            status: 0,
            signal: null,
            stdout: stdout(),
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** A child that waits for the barrier, then runs one or more slots. */
function runner(): string {
    return `
import { appendFileSync, existsSync } from "node:fs";
import { runCampaign } from ${JSON.stringify(RUN_MODULE)};
const [root, start, log, slotsJson] = process.argv.slice(2);
const deadline = Date.now() + 10000;
while (!existsSync(start) && Date.now() < deadline) {
    await new Promise((again) => setTimeout(again, 5));
}
const summary = await runCampaign(root, { slotIds: JSON.parse(slotsJson) }, {
    now: () => "2026-11-17T00:00:00.000Z",
    runContainer: async () => {
        appendFileSync(log, "dispatch\\n");
        return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ type: "text", sessionID: "s", messageID: "m", part: { type: "text", text: "Done." } }) + "\\n",
            stderr: "",
            timedOut: false,
            error: null,
        };
    },
});
appendFileSync(log, "RESULT " + JSON.stringify(summary) + "\\n");
`;
}

/** Run children concurrently behind one start barrier. */
async function race(
    dir: string,
    root: string,
    slots: string[][],
): Promise<{ dispatches: number; results: Array<Record<string, unknown>> }> {
    const script = join(dir, "runner.mjs");
    writeFileSync(script, runner(), "utf8");
    const start = join(dir, "start");
    const log = join(dir, "race.log");
    writeFileSync(log, "", "utf8");
    const children = slots.map(
        (selection) =>
            new Promise<string>((done, fail) => {
                const child = spawn(
                    process.execPath,
                    [script, root, start, log, JSON.stringify(selection)],
                    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
                );
                let stderr = "";
                child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
                child.on("error", fail);
                child.on("close", (code) =>
                    code === 0 ? done(stderr) : fail(new Error(stderr)),
                );
            }),
    );
    // Release every contender at once.
    writeFileSync(start, "go\n", "utf8");
    await Promise.all(children);
    const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return {
        dispatches: lines.filter((line) => line === "dispatch").length,
        results: lines
            .filter((line) => line.startsWith("RESULT "))
            .map(
                (line) =>
                    JSON.parse(line.slice("RESULT ".length)) as Record<
                        string,
                        unknown
                    >,
            ),
    };
}

describe("durable trial reservations", () => {
    const dirs: string[] = [];
    const made = async (budget?: number) => {
        const entry = await root(budget);
        dirs.push(entry.dir);
        return entry;
    };

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("dispatches exactly one of two different slots with one allowance", async () => {
        // Arrange
        const { dir, root: campaignRoot } = await made(1);

        // Act
        const raced = await race(dir, campaignRoot, [["s1"], ["s2"]]);

        // Assert
        assert.equal(raced.dispatches, 1);
        assert.equal(
            raced.results.filter((result) => Array.isArray(result.ran) && result.ran.length === 1).length,
            1,
        );
        assert.equal(readClaims(join(campaignRoot, "evidence"), "trial").length, 1);
    });

    it("dispatches one contender for the same slot and leaves one terminal record", async () => {
        // Arrange
        const { dir, root: campaignRoot } = await made();

        // Act
        const raced = await race(dir, campaignRoot, [["s1"], ["s1"]]);

        // Assert
        assert.equal(raced.dispatches, 1);
        const terminals = readFileSync(
            join(campaignRoot, "evidence", "ATTEMPTS.jsonl"),
            "utf8",
        )
            .split("\n")
            .filter((line) => line.includes('"trial-end"'));
        assert.equal(terminals.length, 1);
        assert.equal(existsSync(join(trialDirectory(campaignRoot, "s1"), "meta.json")), true);
    });

    it("spends at most the remaining allowances across three contenders", async () => {
        // Arrange
        const { dir, root: campaignRoot } = await made(2);
        const first = await runCampaign(
            campaignRoot,
            { slotIds: ["s1"] },
            { runContainer: scripted(join(dir, "first.log")) },
        );
        assert.equal(first.ok, true, first.problems.join("; "));

        // Act
        const raced = await race(dir, campaignRoot, [["s2"], ["s3"], ["s2"]]);

        // Assert
        assert.equal(raced.dispatches, 1, "one allowance remains, one dispatch");
        assert.equal(readClaims(join(campaignRoot, "evidence"), "trial").length, 2);
        assert.equal(
            (statusOf(campaignRoot).budgets?.remaining ?? -1),
            0,
        );
    });

    it("does not block a separate campaign", async () => {
        // Arrange
        const one = await made(1);
        const two = await made(1);

        // Act
        const raced = await race(one.dir, one.root, [["s1"]]);
        const other = await runCampaign(
            two.root,
            { slotIds: ["s1"] },
            { runContainer: scripted(join(two.dir, "other.log")) },
        );

        // Assert
        assert.equal(raced.dispatches, 1);
        assert.equal(other.ok, true, other.problems.join("; "));
        assert.deepEqual(other.ran, ["s1"]);
    });

    it("keeps a reservation that never dispatched and refuses closure", async () => {
        // Arrange
        const { root: campaignRoot } = await made(2);
        const claimed = claimBudget(
            join(campaignRoot, "evidence"),
            "trial",
            2,
            { stamp: "s1", key: "slot:s1", note: "crashed before dispatch" },
        );
        assert.equal(claimed.ok, true);

        // Act
        const retry = await runCampaign(campaignRoot, { slotIds: ["s1"] });
        const closed = closeCampaign(campaignRoot);

        // Assert
        assert.equal(retry.ran.length, 0);
        assert.equal(closed.ok, false);
        assert.match(
            closed.ok ? "" : closed.problems.join("; "),
            /unsettled spend/,
        );
        const claims = readClaims(join(campaignRoot, "evidence"), "trial");
        assert.equal(claims.length, 1);
        assert.equal(claims[0]?.state, "reserved");
    });

    it("never refunds a spawned claim with an unresolved launch", async () => {
        // Arrange
        const { root: campaignRoot } = await made(1);
        const claimed = claimBudget(
            join(campaignRoot, "evidence"),
            "trial",
            1,
            { stamp: "s1", key: "slot:s1", note: "dispatch started" },
        );
        assert.equal(claimed.ok, true);
        if (!claimed.ok) return;
        const spawned = advanceClaim(claimed.claim, "spawned", {
            stamp: "s1",
        });
        mkdirSync(trialDirectory(campaignRoot, "s1"), { recursive: true });
        appendLedgerEvent(campaignRoot, {
            event: "trial-start",
            campaignId: "skill-basic-local",
            slotId: "s1",
            trialId: "s1",
            caseId: "positive-instrument",
            armId: "skill-only",
            repetitionId: "r0",
            imageId: IMAGE_ID,
            promptSha256: "unknown",
        });

        // Act
        const closed = closeCampaign(campaignRoot);
        const refunded = releaseClaim(spawned);
        const retry = await runCampaign(campaignRoot, { slotIds: ["s2"] });

        // Assert
        assert.equal(closed.ok, false);
        assert.match(
            closed.ok ? "" : closed.problems.join("; "),
            /unresolved trial launch/,
        );
        assert.equal(refunded, false, "a spawned claim is never silently refunded");
        assert.equal(retry.ran.length, 0);
    });

    it("releases a claim when planning fails before dispatch", async () => {
        // Arrange
        const { root: campaignRoot } = await made(1);
        rmSync(join(campaignRoot, "prepare", "prompts", "positive-instrument.txt"));

        // Act
        const summary = await runCampaign(campaignRoot, { slotIds: ["s1"] });

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(readClaims(join(campaignRoot, "evidence"), "trial").length, 0);
    });

    it("refuses a new dispatch after closure, claiming nothing", async () => {
        // Arrange
        const { dir, root: campaignRoot } = await made(2);
        const first = await runCampaign(
            campaignRoot,
            { slotIds: ["s1"] },
            { runContainer: scripted(join(dir, "first.log")) },
        );
        assert.equal(first.ok, true);
        assert.equal(
            assessCampaign(campaignRoot, {
                now: () => "2026-11-17T00:00:00.000Z",
            }).ok,
            true,
        );
        const closed = closeCampaign(campaignRoot);
        assert.equal(closed.ok, true, closed.ok ? "" : closed.problems.join("; "));

        // Act
        const second = await runCampaign(campaignRoot, { slotIds: ["s2"] });

        // Assert
        assert.equal(second.ran.length, 0);
        assert.match(second.problems.join("; "), /closed/);
        assert.equal(readClaims(join(campaignRoot, "evidence"), "trial").length, 1);
    });
});
