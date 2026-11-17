import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign, trialDirectory } from "../../src/campaign/run.ts";
import { assessCampaign, assessmentPath } from "../../src/campaign/assess.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"9".repeat(64)}`;

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

/** One completed text event. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_terminal",
        messageID: "msg_terminal",
        part: { type: "text", text },
    });
}

/** A prepared and frozen docs root. */
async function root(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-terminal-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const rootPath = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), rootPath);
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

describe("assessment is terminal-only", () => {
    it("refuses to persist while the primary checker is still running", async () => {
        // Arrange
        const made = await root();
        try {
            const captured: { plan: ContainerPlan | null } = { plan: null };
            let releaseChecker!: () => void;
            const checkerDone = new Promise<void>((done) => {
                releaseChecker = done;
            });
            let markStarted!: () => void;
            const started = new Promise<void>((done) => {
                markStarted = done;
            });
            const signal = new AbortController().signal;
            const container = async (
                plan: ContainerPlan,
            ): Promise<CommandResult> => {
                if (plan.argv[0] === "node") {
                    captured.plan = plan;
                    markStarted();
                    await checkerDone;
                    return {
                        status: 0,
                        signal: null,
                        stdout: "",
                        stderr: "",
                        timedOut: false,
                        error: null,
                    };
                }
                return {
                    status: 0,
                    signal: null,
                    stdout: `${textEvent("Done.")}\n`,
                    stderr: "",
                    timedOut: false,
                    error: null,
                };
            };
            const running = runCampaign(
                made.root,
                { slotIds: ["primary-failure"], signal },
                {
                    runContainer: container,
                    now: () => "2026-11-17T00:00:00.000Z",
                },
            );

            // Act
            await started;
            const early = assessCampaign(made.root, {
                slotIds: ["primary-failure"],
                now: () => "2026-11-17T00:05:00.000Z",
            });
            const earlyFile = existsSync(
                assessmentPath(made.root, "primary-failure"),
            );
            releaseChecker();
            const summary = await running;
            const later = assessCampaign(made.root, {
                slotIds: ["primary-failure"],
                now: () => "2026-11-17T00:10:00.000Z",
            });

            // Assert
            assert.equal(summary.ok, true, summary.problems.join("; "));
            assert.equal(early.ok, true);
            assert.equal(early.summary.assessed, 0);
            assert.match(early.skipped.join("; "), /not terminal/);
            assert.equal(
                earlyFile,
                false,
                "an in-flight attempt wrote an assessment",
            );
            assert.equal(later.summary.assessed, 1);
            assert.equal(
                existsSync(assessmentPath(made.root, "primary-failure")),
                true,
            );
            assert.equal(later.skipped.length, 0);

            // The checker plan carries ownership and cancellation, and its env
            // file is gone by the time the run completes.
            const trial = trialDirectory(made.root, "primary-failure");
            assert.notEqual(captured.plan, null);
            assert.equal(typeof captured.plan?.name, "string");
            assert.equal(
                captured.plan?.labels?.["otc.checker"],
                "primary-failure",
            );
            assert.equal(captured.plan?.signal, signal);
            assert.equal(existsSync(join(trial, "checker.env")), false);
        } finally {
            rmSync(made.dir, { recursive: true, force: true });
        }
    });
});
