import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { judgeSandboxPlanForSlot } from "../../src/campaign/judge.ts";
import { containerArgv } from "../../src/adapters/podman/container.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"4".repeat(64)}`;

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

/** A completed text event carrying a large answer. */
function largeAnswer(size: number): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_packet",
        messageID: "msg_packet",
        part: {
            type: "text",
            text: `PACKET-MARKER-${"a".repeat(size)}-PACKET-END`,
        },
    });
}

/** Prepare, freeze and run one docs trial with a large answer. */
async function largeRoot(size: number): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-packet-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    const ran = await runCampaign(
        root,
        { slotIds: ["restraint"] },
        {
            runContainer: async (plan: ContainerPlan) => {
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
                return {
                    status: 0,
                    signal: null,
                    stdout: `${largeAnswer(size)}\n`,
                    stderr: "",
                    timedOut: false,
                    error: null,
                };
            },
        },
    );
    assert.equal(ran.ok, true, ran.problems.join("; "));
    const assessed = assessCampaign(root);
    assert.equal(assessed.ok, true, assessed.problems.join("; "));
    return { dir, root };
}

describe("judge packet transport", () => {
    it("streams a packet above the argument limit on stdin", async () => {
        // Arrange: 200 KiB of answer becomes part of the blinded packet.
        const { dir, root } = await largeRoot(200 * 1024);
        try {
            // Act
            const built = judgeSandboxPlanForSlot(
                root,
                "restraint",
                "attempt-001",
            );

            // Assert
            assert.equal(
                built.ok,
                true,
                built.ok ? "" : built.problems.join("; "),
            );
            if (!built.ok) return;
            const packet = built.plan.stdin;
            assert.equal(typeof packet, "string");
            assert.equal((packet ?? "").length > 200 * 1024, true);
            assert.match(packet ?? "", /PACKET-MARKER-/);
            for (const argument of built.plan.argv) {
                assert.equal(
                    argument.includes("PACKET-MARKER-"),
                    false,
                    "the packet is in the argument vector",
                );
            }
            const argv = containerArgv(built.plan);
            assert.equal(argv.includes("-i"), true);
            for (const argument of argv) {
                assert.equal(
                    Buffer.byteLength(argument) < 128 * 1024,
                    true,
                    "an argument exceeds the host's single-argument limit",
                );
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
