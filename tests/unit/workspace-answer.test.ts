import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const ANSWER = "The subject's final answer.";

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

/** The mount source for one container target. */
function mountSource(plan: ContainerPlan, target: string): string {
    const mount = plan.mounts.find((entry) => entry.target === target);
    assert.notEqual(mount, undefined);
    return (mount as { source: string }).source;
}

/** Prepare and freeze the docs fixture. */
async function frozenRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-answer-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

/** A scripted trial that may write into its workspace first. */
function trial(work?: (workspace: string) => void) {
    return async (plan: ContainerPlan): Promise<CommandResult> => {
        if (plan.argv[0] !== "node") {
            const workspace = mountSource(plan, "/workspace");
            work?.(workspace);
        }
        return {
            status: 0,
            signal: null,
            stdout: `${JSON.stringify({
                type: "text",
                sessionID: "ses_answer",
                messageID: "msg_answer",
                part: { type: "text", text: ANSWER },
            })}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

describe("workspace answer placement", () => {
    it("keeps an existing subject answer and the canonical evidence", async () => {
        // Arrange
        const { dir, root } = await frozenRoot();
        const subject = "The subject wrote its own answer.\n";
        try {
            // Act
            const ran = await runCampaign(
                root,
                { slotIds: ["restraint"] },
                {
                    runContainer: trial((workspace) => {
                        writeFileSync(
                            join(workspace, "answer.md"),
                            subject,
                            "utf8",
                        );
                    }),
                },
            );

            // Assert
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const trialDir = join(root, "evidence", "trials", "restraint");
            assert.equal(
                readFileSync(join(trialDir, "workspace", "answer.md"), "utf8"),
                subject,
            );
            assert.equal(
                readFileSync(join(trialDir, "answer.md"), "utf8").trim(),
                ANSWER,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("creates an ordinary missing workspace answer", async () => {
        // Arrange
        const { dir, root } = await frozenRoot();
        try {
            // Act
            const ran = await runCampaign(
                root,
                { slotIds: ["restraint"] },
                { runContainer: trial() },
            );

            // Assert
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const trialDir = join(root, "evidence", "trials", "restraint");
            assert.equal(
                readFileSync(
                    join(trialDir, "workspace", "answer.md"),
                    "utf8",
                ),
                readFileSync(join(trialDir, "answer.md"), "utf8"),
            );
            const meta = JSON.parse(
                readFileSync(join(trialDir, "meta.json"), "utf8"),
            ) as { captureValid: boolean };
            assert.equal(meta.captureValid, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a symlinked destination and leaves host evidence intact", async () => {
        // Arrange
        const { dir, root } = await frozenRoot();
        const outside = mkdtempSync(join(tmpdir(), "otc-answer-outside-"));
        const sentinel = join(outside, "sentinel.txt");
        writeFileSync(sentinel, "HOST-OWNED\n", "utf8");
        try {
            // Act
            const ran = await runCampaign(
                root,
                { slotIds: ["restraint"] },
                {
                    runContainer: trial((workspace) => {
                        mkdirSync(workspace, { recursive: true });
                        rmSync(join(workspace, "answer.md"), { force: true });
                        symlinkSync(sentinel, join(workspace, "answer.md"));
                    }),
                },
            );

            // Assert
            assert.equal(ran.ok, false);
            assert.match(
                ran.problems.join("; "),
                /answer\.md is unsafe|answer\.md resolves outside/,
            );
            assert.equal(readFileSync(sentinel, "utf8"), "HOST-OWNED\n");
            const trialDir = join(root, "evidence", "trials", "restraint");
            assert.equal(
                readFileSync(join(trialDir, "answer.md"), "utf8").trim(),
                ANSWER,
            );
            const meta = JSON.parse(
                readFileSync(join(trialDir, "meta.json"), "utf8"),
            ) as { captureValid: boolean; captureProblems: string[] };
            assert.equal(meta.captureValid, false);
            assert.match(meta.captureProblems.join("; "), /unsafe/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(outside, { recursive: true, force: true });
        }
    });
});
