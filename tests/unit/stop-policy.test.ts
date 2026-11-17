import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Campaign } from "../../src/contracts/types.ts";
import {
    assessShouldStop,
    judgeShouldStop,
    runShouldStop,
} from "../../src/campaign/stop-policy.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { judgeCampaign } from "../../src/campaign/judge.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "fixtures", "docs-campaign");
const SKILLS = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"2".repeat(64)}`;

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
        sessionID: "ses_stop",
        messageID: "msg_stop",
        part: { type: "text", text },
    });
}

/** A campaign value with stop policy chosen. */
function policy(version: 1 | 2 | undefined): Campaign {
    return {
        schemaVersion: 1,
        campaignId: "policy",
        suite: { path: "suite.json" },
        subjects: [],
        schedule: { kind: "explicit", slots: [] },
        runtime: {
            image: "image",
            opencodeVersion: "2.2.6",
            provider: { route: "scripted", model: "scripted/x" },
            timeoutMs: 1,
            network: "none",
        },
        budgets: { trials: 1, judgeAttempts: 0 },
        assessment: { kind: "skill-activation" },
        stopOnFirstFailure: true,
        ...(version === 2 ? { stopPolicy: { version: 2 as const } } : {}),
    };
}

/** Copy a fixture and patch its campaign. */
function fixture(
    source: string,
    patch: (campaign: Record<string, unknown>) => void,
): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-stop-"));
    cpSync(source, dir, { recursive: true });
    const campaignPath = join(dir, "campaign.json");
    const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as Record<
        string,
        unknown
    >;
    patch(campaign);
    writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);
    return { dir, campaignPath };
}

/** Prepare and freeze a fixture root. */
async function root(
    source: string,
    patch: (campaign: Record<string, unknown>) => void,
): Promise<{ dir: string; root: string }> {
    const made = fixture(source, patch);
    const rootPath = join(made.dir, "root");
    const prepared = prepareCampaign(made.campaignPath, rootPath);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(rootPath, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir: made.dir, root: rootPath };
}

describe("stop-policy truth table", () => {
    it("run stops on capture, exit and primary-check failure under version 2", () => {
        // Arrange
        const v2 = policy(2);
        const v1 = policy(1);

        // Act / Assert
        assert.equal(
            runShouldStop(v2, { captureValid: false, exit: 0, primaryStatus: null }),
            true,
        );
        assert.equal(
            runShouldStop(v2, { captureValid: true, exit: 1, primaryStatus: null }),
            true,
        );
        assert.equal(
            runShouldStop(v2, { captureValid: true, exit: 0, primaryStatus: "fail" }),
            true,
        );
        assert.equal(
            runShouldStop(v2, { captureValid: true, exit: 0, primaryStatus: "pass" }),
            false,
        );
        assert.equal(
            runShouldStop(v1, { captureValid: true, exit: 0, primaryStatus: "fail" }),
            false,
            "version 1 ignores a primary-check outcome",
        );
    });

    it("assess stops on fail or invalid only under version 2", () => {
        // Arrange
        const fail = { outcome: "fail", validity: "valid" } as never;
        const invalid = { outcome: "unknown", validity: "invalid" } as never;
        const pass = { outcome: "pass", validity: "valid" } as never;

        // Act / Assert
        assert.equal(assessShouldStop(policy(2), fail), true);
        assert.equal(assessShouldStop(policy(2), invalid), true);
        assert.equal(assessShouldStop(policy(2), pass), false);
        assert.equal(assessShouldStop(policy(1), fail), false);
        assert.equal(assessShouldStop(policy(undefined), fail), false);
    });

    it("judge stops on an adverse verdict or a problem under version 2", () => {
        // Arrange
        const calm = { problems: [], adverse: false };
        const adverse = { problems: [], adverse: true };
        const broken = { problems: ["transport"], adverse: false };

        // Act / Assert
        assert.equal(judgeShouldStop(policy(2), calm), false);
        assert.equal(judgeShouldStop(policy(2), adverse), true);
        assert.equal(judgeShouldStop(policy(2), broken), true);
        assert.equal(judgeShouldStop(policy(1), adverse), false);
        assert.equal(judgeShouldStop(policy(1), broken), true);
        assert.equal(
            judgeShouldStop(
                {
                    ...policy(2),
                    stopOnFirstFailure: undefined as unknown as boolean,
                },
                adverse,
            ),
            false,
        );
    });
});

describe("stop-policy execution", () => {
    const dirs: string[] = [];
    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("version 2 stops a run after a primary-check failure; version 1 continues", async () => {
        // Arrange
        const stop = await root(DOCS, (campaign) => {
            campaign.stopOnFirstFailure = true;
            campaign.stopPolicy = { version: 2 };
        });
        const legacy = await root(DOCS, (campaign) => {
            campaign.stopOnFirstFailure = true;
        });
        dirs.push(stop.dir, legacy.dir);
        const container = async (plan: ContainerPlan): Promise<CommandResult> => {
            const failing = plan.argv[1]?.includes("fail.mjs") === true;
            return {
                status: failing ? 3 : 0,
                signal: null,
                stdout: `${textEvent("Done.")}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        };
        const selection = ["primary-failure", "useful-write"];

        // Act
        const v2 = await runCampaign(
            stop.root,
            { slotIds: selection },
            { runContainer: container },
        );
        const v1 = await runCampaign(
            legacy.root,
            { slotIds: selection },
            { runContainer: container },
        );

        // Assert
        assert.deepEqual(v2.ran, ["primary-failure"]);
        assert.deepEqual(v1.ran, ["primary-failure", "useful-write"]);
    });

    it("version 2 stops judging after an adverse verdict; version 1 continues", async () => {
        // Arrange
        const stop = await root(DOCS, (campaign) => {
            campaign.stopOnFirstFailure = true;
            campaign.stopPolicy = { version: 2 };
        });
        const legacy = await root(DOCS, (campaign) => {
            campaign.stopOnFirstFailure = true;
        });
        dirs.push(stop.dir, legacy.dir);
        const selection = ["useful-write", "restraint"];
        const trial = async (plan: ContainerPlan): Promise<CommandResult> => {
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
            const title = plan.argv[plan.argv.indexOf("--title") + 1] ?? "";
            if (title.endsWith("-useful-write")) {
                const mount = plan.mounts.find(
                    (entry) => entry.target === "/workspace",
                );
                const workspace = (mount as { source: string }).source;
                const { mkdirSync } = await import("node:fs");
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
                stdout: `${textEvent("Done.")}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        };
        const judge = async (plan: ContainerPlan): Promise<CommandResult> => {
            const title = plan.argv[plan.argv.indexOf("--title") + 1] ?? "";
            const changed = title.includes("useful-write");
            const value = {
                documentationOutcome: changed ? "misleading" : "none",
                documentationReason: changed
                    ? "The recorded note misstates the convention."
                    : "The change is not worth recording.",
                evidence: [changed ? "The note is wrong." : "No document changed."],
            };
            return {
                status: 0,
                signal: null,
                stdout: `${textEvent(JSON.stringify(value))}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        };

        // Act
        await runCampaign(stop.root, { slotIds: selection }, { runContainer: trial });
        await runCampaign(legacy.root, { slotIds: selection }, { runContainer: trial });
        const v2 = await judgeCampaign(
            stop.root,
            { slotIds: selection },
            { runContainer: judge },
        );
        const v1 = await judgeCampaign(
            legacy.root,
            { slotIds: selection },
            { runContainer: judge },
        );

        // Assert
        assert.deepEqual(v2.judged, ["useful-write"], v2.problems.join("; "));
        assert.deepEqual(v1.judged, ["useful-write", "restraint"], v1.problems.join("; "));
    });

    it("version 2 stops assessment after a deterministic fail; version 1 does not", async () => {
        // Arrange
        const stop = await root(SKILLS, (campaign) => {
            campaign.stopOnFirstFailure = true;
            campaign.stopPolicy = { version: 2 };
        });
        const legacy = await root(SKILLS, (campaign) => {
            campaign.stopOnFirstFailure = true;
        });
        dirs.push(stop.dir, legacy.dir);
        const silent = async (_plan: ContainerPlan): Promise<CommandResult> => ({
            status: 0,
            signal: null,
            stdout: `${textEvent("No activation.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        });

        // Act
        await runCampaign(stop.root, {}, { runContainer: silent });
        await runCampaign(legacy.root, {}, { runContainer: silent });
        const v2 = assessCampaign(stop.root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });
        const v1 = assessCampaign(legacy.root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });

        // Assert
        assert.equal(v2.stoppedAt, "s1");
        assert.equal(v2.summary.assessed, 1);
        assert.equal(v1.stoppedAt, null);
        assert.equal(v1.summary.assessed, 3);
    });
});
