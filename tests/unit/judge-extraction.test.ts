import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { judgeCampaign } from "../../src/campaign/judge.ts";
import {
    buildPacket,
    blindingProblems,
} from "../../src/evaluators/docs/packet.ts";
import { classifyAttempt } from "../../src/evaluators/docs/verdict.ts";
import { decodeTrail } from "../../src/adapters/opencode/events.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";
import {
    docsCallEvent,
    textEvent,
    validJudgement,
    writeJournal,
} from "../support/docs-trial.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"5".repeat(64)}`;

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

/** A scripted docs container. */
function container(): (plan: ContainerPlan) => Promise<CommandResult> {
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
            const workspace = plan.mounts.find(
                (mount) => mount.target === "/workspace",
            )?.source;
            assert.notEqual(workspace, undefined);
            if (workspace !== undefined) {
                const { mkdirSync, writeFileSync } = await import("node:fs");
                mkdirSync(join(workspace, "docs", "notes"), {
                    recursive: true,
                });
                writeFileSync(
                    join(workspace, "docs", "notes", "otel.md"),
                    "# OpenTelemetry\n\nName spans after the operation.\n",
                    "utf8",
                );
            }
        }
        return {
            status: 0,
            signal: null,
            stdout: `${
                slot === "useful-write" ? `${docsCallEvent()}\n` : ""
            }${textEvent("Recorded the convention.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

describe("judge extraction parity", () => {
    it("builds the same packet the campaign froze and registered", async () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-extract-"));
        cpSync(FIXTURE, dir, { recursive: true });
        const root = join(dir, "root");
        const runs = container();
        try {
            const prepared = prepareCampaign(join(dir, "campaign.json"), root);
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            if (!prepared.ok) return;
            const frozen = await freezeCampaign(root, fakeImage as never);
            assert.equal(frozen.ok, true);
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));
            const judged = await judgeCampaign(
                root,
                {
                    slotIds: ["useful-write"],
                },
                { runContainer: runs },
            );
            assert.equal(judged.ok, true, judged.problems.join("; "));

            const slot = prepared.manifest.campaign.schedule.slots.find(
                (entry) => entry.slotId === "useful-write",
            );
            const testCase = prepared.manifest.suite.cases.find(
                (entry) => entry.caseId === "useful-write",
            );
            assert.equal(testCase?.kind, "docs-task");
            assert.notEqual(slot, undefined);
            assert.notEqual(testCase, undefined);
            if (
                slot === undefined ||
                testCase === undefined ||
                testCase.kind !== "docs-task"
            ) {
                return;
            }

            // Act
            const rebuilt = buildPacket({ root, slot, testCase });
            const registered = readFileSync(
                join(
                    root,
                    "evidence",
                    "judgements",
                    "useful-write",
                    "attempt-001",
                    "packet.md",
                ),
                "utf8",
            );
            const leaks = blindingProblems(registered, {
                root,
                campaignId: prepared.manifest.campaignId,
                armIds: prepared.manifest.campaign.subjects.map(
                    (arm) => arm.armId,
                ),
                slotIds: prepared.manifest.campaign.schedule.slots.map(
                    (entry) => entry.slotId,
                ),
                caseIds: prepared.manifest.suite.cases.map(
                    (entry) => entry.caseId,
                ),
            });

            // Assert
            assert.equal(rebuilt.ok, true);
            assert.equal(rebuilt.ok ? rebuilt.packet : "", registered);
            assert.deepEqual(leaks, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifies a verdict from the docs evaluator without campaign state", () => {
        // Arrange
        const result: CommandResult = {
            status: 0,
            signal: null,
            stdout: `${textEvent(
                JSON.stringify({
                    documentationOutcome: "none",
                    documentationReason: "Nothing durable changed.",
                    evidence: ["The workspace is unchanged."],
                }),
            )}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
        const state = {
            documentsChanged: false,
            createdPaths: [],
            modifiedPaths: [],
        };

        // Act
        const outcome = classifyAttempt(result, state);

        // Assert
        assert.equal(outcome.status, "judged");
        assert.equal(outcome.failureClass, null);
        assert.equal(outcome.complete, true);
        assert.equal(decodeTrail(result.stdout).textParts, 1);
    });
});
