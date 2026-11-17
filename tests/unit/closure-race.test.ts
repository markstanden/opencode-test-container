import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
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
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import { withAdmission } from "../../src/campaign/admission.ts";
import { utimesSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"7".repeat(64)}`;
const RUN_MODULE = pathToFileURL(
    join(HERE, "..", "..", "src", "campaign", "run.ts"),
).href;
const CLOSE_MODULE = pathToFileURL(
    join(HERE, "..", "..", "src", "campaign", "close.ts"),
).href;

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

/** A prepared and frozen one-slot root. */
async function root(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-close-race-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const campaignPath = join(dir, "campaign.json");
    const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
        budgets: { trials: number; judgeAttempts: number };
        schedule: { slots: unknown[] };
    };
    campaign.budgets = { trials: 1, judgeAttempts: 0 };
    campaign.schedule.slots = campaign.schedule.slots.slice(0, 1);
    writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    const rootPath = join(dir, "root");
    const prepared = prepareCampaign(campaignPath, rootPath);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(
        rootPath,
        fakeImage as typeof runCommand,
    );
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root: rootPath };
}

/** A child that waits on the barrier, then runs its command. */
function child(kind: "run" | "close"): string {
    return `
import { existsSync, appendFileSync } from "node:fs";
import { runCampaign } from ${JSON.stringify(RUN_MODULE)};
import { closeCampaign } from ${JSON.stringify(CLOSE_MODULE)};
const [root, start, log] = process.argv.slice(2);
while (!existsSync(start)) await new Promise((again) => setTimeout(again, 5));
if (${JSON.stringify(kind)} === "close") {
    appendFileSync(log, JSON.stringify(closeCampaign(root, () => "2026-11-17T00:00:00.000Z")) + "\\n");
} else {
    const text = JSON.stringify({ type: "text", sessionID: "s", messageID: "m", part: { type: "text", text: "Done." } });
    const result = await runCampaign(root, { slotIds: ["s1"] }, {
        now: () => "2026-11-17T00:00:00.000Z",
        runContainer: async () => ({ status: 0, signal: null, stdout: text + "\\n", stderr: "", timedOut: false, error: null }),
    });
    appendFileSync(log, JSON.stringify(result) + "\\n");
}
`;
}

/** Run the two children behind one barrier and return their parsed results. */
async function race(options: {
    dir: string;
    root: string;
}): Promise<{ close: { ok: boolean }; run: { ran: string[] } }> {
    const script = join(options.dir, "race.mjs");
    const closeScript = join(options.dir, "race-close.mjs");
    const runScript = join(options.dir, "race-run.mjs");
    writeFileSync(closeScript, child("close"), "utf8");
    writeFileSync(runScript, child("run"), "utf8");
    void script;
    const start = join(options.dir, "start");
    const closeLog = join(options.dir, "close.log");
    const runLog = join(options.dir, "run.log");
    writeFileSync(closeLog, "", "utf8");
    writeFileSync(runLog, "", "utf8");
    const launch = (path: string, log: string) =>
        new Promise<void>((done, fail) => {
            const process = spawn(
                globalThis.process.execPath,
                [path, options.root, start, log],
                { stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            process.stderr.on("data", (chunk: Buffer) => {
                stderr += String(chunk);
            });
            process.on("error", fail);
            process.on("close", (code) =>
                code === 0 ? done() : fail(new Error(stderr)),
            );
        });
    const children = [launch(closeScript, closeLog), launch(runScript, runLog)];
    writeFileSync(start, "go\n", "utf8");
    await Promise.all(children);
    return {
        close: JSON.parse(readFileSync(closeLog, "utf8") || "{}") as {
            ok: boolean;
        },
        run: JSON.parse(readFileSync(runLog, "utf8") || "{}") as {
            ran: string[];
        },
    };
}

describe("closure and dispatch share one admission decision", () => {
    it("never closes before a dispatch that it then permits", async () => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
            // Arrange
            const made = await root();
            try {
                // Act
                const outcome = await race(made);
                const ledger = readLedger(made.root);
                const names = ledger.events.map((event) => event.event);
                const closeAt = names.indexOf("close");
                const startAt = names.indexOf("trial-start");

                // Assert
                assert.equal(
                    closeAt !== -1 && startAt > closeAt,
                    false,
                    `attempt ${attempt}: a trial started after closure (${names.join(",")})`,
                );
                if (outcome.close.ok) {
                    assert.equal(
                        existsSync(join(made.root, "evidence", "trials", "s1")),
                        false,
                        `attempt ${attempt}: closure succeeded but a trial exists`,
                    );
                    assert.equal(outcome.run.ran.length, 0);
                }
            } finally {
                rmSync(made.dir, { recursive: true, force: true });
            }
        }
    });
});

describe("admission lock recovery", () => {
    it("recovers a lock only when its recorded owner is gone", async () => {
        // Arrange
        const made = await root();
        const path = join(made.root, "evidence", "ADMISSION.lock");
        try {
            mkdirSync(join(made.root, "evidence"), { recursive: true });
            writeFileSync(
                path,
                `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`,
                "utf8",
            );
            const old = new Date(Date.now() - 60_000);
            utimesSync(path, old, old);

            // Act
            const entered = withAdmission(made.root, () => "entered");

            // Assert
            assert.deepEqual(entered, { ok: true, value: "entered" });
        } finally {
            rmSync(made.dir, { recursive: true, force: true });
        }
    });
});
