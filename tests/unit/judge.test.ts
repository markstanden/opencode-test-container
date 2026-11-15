import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
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
import { closeCampaign } from "../../src/campaign/close.ts";
import { statusOf } from "../../src/campaign/status.ts";
import { analyseCampaign } from "../../src/reporting/report.ts";
import {
    buildJudgePacketForSlot,
    checkedSelectionForSlot,
    judgeCampaign,
    readJudgeAttempts,
} from "../../src/campaign/judge.ts";
import { readClaims } from "../../src/evaluators/docs/analysis/budget.ts";
import { toolIdentity } from "../../src/contracts/version.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"c".repeat(64)}`;

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

/** One completed answer event. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_test",
        messageID: "msg_text",
        part: { type: "text", text },
    });
}

/** The mount source for one container target. */
function mountSource(plan: ContainerPlan, target: string): string {
    const mount = plan.mounts.find((entry) => entry.target === target);
    assert.notEqual(mount, undefined);
    return (mount as { source: string }).source;
}

/** The argv value after one flag. */
function flagValue(plan: ContainerPlan, flag: string): string {
    const index = plan.argv.indexOf(flag);
    return plan.argv[index + 1] ?? "";
}

/** A scripted trial stream for one slot. */
function trialStream(slotId: string): string {
    return `${textEvent(
        slotId === "useful-write"
            ? "Recorded the convention."
            : "Renamed the variable.",
    )}\n`;
}

/** A judgement payload. */
function judgement(outcome: string): string {
    return JSON.stringify({
        documentationOutcome: outcome,
        documentationReason: "The evidence supports this outcome.",
        evidence: ["docs/notes/otel.md"],
    });
}

/** The fake container: trials, primary checks and judge dispatches. */
function container(options: {
    judgeResponses?: (slotId: string, attemptId: string) => string;
    record?: string[];
}) {
    return async (plan: ContainerPlan): Promise<CommandResult> => {
        if (plan.argv[0] === "node") {
            const failing = plan.argv[1]?.includes("fail.mjs") === true;
            return {
                status: failing ? 3 : 0,
                signal: null,
                stdout: "",
                stderr: failing ? "failed\n" : "",
                timedOut: false,
                error: null,
            };
        }
        const title = flagValue(plan, "--title");
        if (title.startsWith("otc-judge-")) {
            const slotId = title
                .slice("otc-judge-".length)
                .replace(/-attempt-\d{3}$/, "");
            const attemptId =
                /attempt-\d{3}$/.exec(title)?.[0] ?? "attempt-001";
            options.record?.push(`${slotId}/${attemptId}`);
            const response =
                options.judgeResponses?.(slotId, attemptId) ??
                judgement(slotId === "useful-write" ? "useful-create" : "none");
            return {
                status: 0,
                signal: null,
                stdout: `${textEvent(response)}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        const slotId =
            ["useful-write", "restraint", "primary-failure"].find((id) =>
                title.endsWith(`-${id}`),
            ) ?? "";
        if (slotId === "useful-write") {
            const workspace = mountSource(plan, "/workspace");
            mkdirSync(join(workspace, "docs", "notes"), { recursive: true });
            writeFileSync(
                join(workspace, "docs", "notes", "otel.md"),
                "# OpenTelemetry note\n\nName spans after the operation.\n",
                "utf8",
            );
        }
        return {
            status: 0,
            signal: null,
            stdout: trialStream(slotId),
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** Copy the fixture campaign and optionally patch its documents. */
function fixtureCampaign(
    options: {
        campaign?: (campaign: Record<string, unknown>) => void;
        suite?: (suite: Record<string, unknown>) => void;
    } = {},
): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-judge-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const campaignPath = join(dir, "campaign.json");
    if (options.campaign !== undefined) {
        const campaign = JSON.parse(
            readFileSync(campaignPath, "utf8"),
        ) as Record<string, unknown>;
        options.campaign(campaign);
        writeFileSync(
            campaignPath,
            `${JSON.stringify(campaign, null, 2)}\n`,
            "utf8",
        );
    }
    if (options.suite !== undefined) {
        const suitePath = join(dir, "suite.json");
        const suite = JSON.parse(readFileSync(suitePath, "utf8")) as Record<
            string,
            unknown
        >;
        options.suite(suite);
        writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
    }
    return { dir, campaignPath };
}

/** Prepare, freeze and run every slot with the scripted container. */
async function campaignRoot(
    mutate?: (campaign: Record<string, unknown>) => void,
    options: {
        run?: boolean;
        suite?: (suite: Record<string, unknown>) => void;
    } = {},
): Promise<{ dir: string; root: string }> {
    const fixture = fixtureCampaign({
        ...(mutate === undefined ? {} : { campaign: mutate }),
        ...(options.suite === undefined ? {} : { suite: options.suite }),
    });
    const root = join(fixture.dir, "root");
    const prepared = prepareCampaign(fixture.campaignPath, root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    if (options.run !== false) {
        const summary = await runCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:00:00.000Z",
            },
        );
        assert.equal(summary.ok, true, summary.problems.join("; "));
    }
    return { dir: fixture.dir, root };
}

/** The checked selection for a slot, or null. */
function selected(root: string, slotId: string) {
    const checked = checkedSelectionForSlot(root, slotId);
    return checked.ok ? checked.value.selection : null;
}

/** Hash every path under a root. */
function treeSnapshot(root: string): string {
    const lines: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
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

describe("blind docs judge", () => {
    const dirs: string[] = [];

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("writes a checked selection for a complete trial", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write", "restraint"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, true, summary.problems.join("; "));
        assert.deepEqual(summary.judged, ["useful-write", "restraint"]);
        const useful = selected(root, "useful-write");
        assert.notEqual(useful, null);
        assert.equal(useful?.selectedAttemptId, "attempt-001");
        assert.equal(useful?.attempts.length, 1);
        const stored = JSON.parse(
            readFileSync(
                join(
                    root,
                    "evidence",
                    "judgements",
                    "useful-write",
                    "attempt-001",
                    "judgement.json",
                ),
                "utf8",
            ),
        ) as { documentationOutcome: string; utility: number };
        assert.equal(stored.documentationOutcome, "useful-create");
        assert.equal(stored.utility, 5);
    });

    it("recovers one complete json-syntax failure from the same packet bytes", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    record: dispatches,
                    judgeResponses: (slotId, attemptId) =>
                        attemptId === "attempt-001"
                            ? "not json"
                            : judgement("useful-create"),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, true, summary.problems.join("; "));
        assert.deepEqual(dispatches, [
            "useful-write/attempt-001",
            "useful-write/attempt-002",
        ]);
        const attempts = readJudgeAttempts(root, "useful-write");
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0]?.failureClass, "json-syntax");
        assert.equal(attempts[0]?.packetSha256, attempts[1]?.packetSha256);
        const selection = selected(root, "useful-write");
        assert.equal(selection?.selectedAttemptId, "attempt-002");
        assert.equal(selection?.attempts.length, 2);
    });

    it("does not recover a schema failure", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    record: dispatches,
                    judgeResponses: () =>
                        JSON.stringify({
                            documentationOutcome: "bogus",
                            documentationReason: "No.",
                            evidence: ["x"],
                        }),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.deepEqual(dispatches, ["useful-write/attempt-001"]);
        const attempts = readJudgeAttempts(root, "useful-write");
        assert.equal(attempts[0]?.failureClass, "schema");
        assert.equal(selected(root, "useful-write"), null);
    });

    it("refuses recovery when the total judge ceiling is exhausted", async () => {
        // Arrange
        const { dir, root } = await campaignRoot((campaign) => {
            const assessment = campaign.assessment as {
                recovery: {
                    totalJudgeAttempts: number;
                    recoveryCeiling: number;
                };
            };
            assessment.recovery.totalJudgeAttempts = 1;
            assessment.recovery.recoveryCeiling = 1;
            (campaign.budgets as { judgeAttempts: number }).judgeAttempts = 1;
        });
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    record: dispatches,
                    judgeResponses: () => "not json",
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.deepEqual(dispatches, ["useful-write/attempt-001"]);
        assert.equal(
            summary.problems.some((problem) => /ceiling/.test(problem)),
            true,
            summary.problems.join("; "),
        );
        assert.equal(selected(root, "useful-write"), null);
    });

    it("does not recover an incomplete capture", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: async (plan) => {
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
                    dispatches.push("judge");
                    return {
                        status: 0,
                        signal: null,
                        stdout: "",
                        stderr: "",
                        timedOut: false,
                        error: null,
                    };
                },
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.deepEqual(dispatches, ["judge"]);
        const attempts = readJudgeAttempts(root, "useful-write");
        assert.equal(attempts[0]?.failureClass, "empty-or-truncated");
    });

    it("is idempotent after a usable judgement", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const before = treeSnapshot(join(root, "evidence", "judgements"));

        // Act
        const second = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:20:00.000Z",
            },
        );

        // Assert
        assert.equal(second.ok, true, second.problems.join("; "));
        assert.deepEqual(second.skipped, ["useful-write"]);
        assert.equal(
            treeSnapshot(join(root, "evidence", "judgements")),
            before,
        );
        assert.equal(readJudgeAttempts(root, "useful-write").length, 1);
    });

    it("reports status without writing", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const before = treeSnapshot(root);

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(treeSnapshot(root), before);
        assert.equal(status.judgement?.pending, 3);
        assert.equal(
            status.nextActions.some((action) =>
                action.command.includes("otc judge"),
            ),
            true,
        );
    });

    it("refuses closure while judgement is pending", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);

        // Act
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(closed.ok, false);
        assert.equal(
            closed.ok
                ? false
                : closed.problems.some((problem) => /unjudged/.test(problem)),
            true,
        );
    });

    it("reports the selected judgement with explicit unjudged slots", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        // Make the remaining judged slots terminal so closure is permitted.
        await judgeCampaign(
            root,
            { slotIds: ["restraint", "primary-failure"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );

        // Act
        const report = analyseCampaign(
            root,
            join(dir, "report"),
            () => "2026-11-15T00:40:00.000Z",
        );

        // Assert
        assert.equal(
            report.ok,
            true,
            report.ok ? "" : report.problems.join("; "),
        );
        if (!report.ok) return;
        assert.equal(report.report.denominators.judged, 3);
        assert.equal(report.report.denominators.unjudged, 0);
        assert.equal(
            report.report.slots.find((slot) => slot.slotId === "useful-write")
                ?.judgement?.documentationOutcome,
            "useful-create",
        );
    });

    it("refuses judge dispatch after closure", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );

        // Act
        const summary = await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:40:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) => /closed/.test(problem)),
            true,
        );
    });

    it("refuses a packet that exposes an arm label", async () => {
        // Arrange
        const { dir, root } = await campaignRoot(undefined, {
            suite: (suite) => {
                const cases = suite.cases as Array<{
                    caseId: string;
                    truth: string;
                }>;
                const useful = cases.find(
                    (entry) => entry.caseId === "useful-write",
                );
                assert.notEqual(useful, undefined);
                (useful as { truth: string }).truth =
                    "The candidate arm should win.";
            },
        });
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) => /not arm-blind/.test(problem)),
            true,
            summary.problems.join("; "),
        );
        assert.equal(selected(root, "useful-write"), null);
    });

    it("refuses a changed frozen packet instead of reusing it", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const slotDir = join(root, "evidence", "judgements", "useful-write");
        mkdirSync(slotDir, { recursive: true });
        writeFileSync(join(slotDir, "packet.md"), "stale packet\n", "utf8");

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:20:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) =>
                /packet .* changed/.test(problem),
            ),
            true,
            summary.problems.join("; "),
        );
        assert.equal(readJudgeAttempts(root, "useful-write").length, 0);
    });

    it("refuses judgement when the campaign declares no judge budget", async () => {
        // Arrange
        const { dir, root } = await campaignRoot((campaign) => {
            (campaign.budgets as { judgeAttempts: number }).judgeAttempts = 0;
        });
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) => /budget is zero/.test(problem)),
            true,
        );
        assert.equal(
            existsSync(join(root, "evidence", "judgements", "useful-write")),
            false,
        );
    });

    it("plans a dry-run judgement without writing evidence", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            {
                slotIds: ["useful-write"],
                dryRun: true,
            },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, true, summary.problems.join("; "));
        assert.equal(
            existsSync(join(root, "evidence", "judgements", "useful-write")),
            false,
        );
    });

    it("records a process failure without recovering", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: async (plan) => {
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
                    dispatches.push("judge");
                    return {
                        status: 1,
                        signal: null,
                        stdout: "",
                        stderr: "judge crashed",
                        timedOut: false,
                        error: null,
                    };
                },
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.deepEqual(dispatches, ["judge"]);
        const attempts = readJudgeAttempts(root, "useful-write");
        assert.equal(attempts[0]?.failureClass, "transport-or-process");
        assert.equal(selected(root, "useful-write"), null);
    });

    it("refuses an unreadable selection", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const selection = join(
            root,
            "evidence",
            "judgements",
            "useful-write",
            "selection.json",
        );
        mkdirSync(dirname(selection), { recursive: true });
        writeFileSync(selection, "not json\n", "utf8");

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) =>
                /selection .* unreadable/.test(problem),
            ),
            true,
        );
    });

    it("refuses closure with an unsettled judge claim", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const claims = join(root, "evidence", "judge");
        mkdirSync(claims, { recursive: true });
        writeFileSync(
            join(claims, "judge-0009.claim"),
            `${JSON.stringify({
                kind: "judge",
                index: 9,
                state: "reserved",
                stamp: "useful-write",
            })}\n`,
            "utf8",
        );

        // Act
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(closed.ok, false);
        assert.equal(
            closed.ok
                ? false
                : closed.problems.some((problem) => /unsettled/.test(problem)),
            true,
        );
    });

    it("reports a terminal judge failure as failed", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            {},
            {
                runContainer: container({
                    judgeResponses: (slotId) =>
                        slotId === "useful-write"
                            ? "not json"
                            : judgement("none"),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.judgement?.failed, 1);
        assert.equal(status.judgement?.pending, 0);
    });

    it("closes after a terminal judge failure", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            {},
            {
                runContainer: container({
                    judgeResponses: (slotId) =>
                        slotId === "useful-write"
                            ? "not json"
                            : judgement("none"),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Act
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );
    });

    it("stops after a second unusable assessment instead of spending again", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const dispatches: string[] = [];

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    record: dispatches,
                    judgeResponses: () => "not json",
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.deepEqual(dispatches, [
            "useful-write/attempt-001",
            "useful-write/attempt-002",
        ]);
        assert.equal(readJudgeAttempts(root, "useful-write").length, 2);
        assert.equal(selected(root, "useful-write"), null);
    });

    it("judges a paired two-arm schedule per slot", async () => {
        // Arrange
        const { dir, root } = await campaignRoot((campaign) => {
            campaign.subjects = [{ armId: "a" }, { armId: "b" }];
            campaign.schedule = {
                kind: "explicit",
                slots: [
                    {
                        slotId: "a-useful",
                        caseId: "useful-write",
                        armId: "a",
                        repetitionId: "r0",
                    },
                    {
                        slotId: "b-useful",
                        caseId: "useful-write",
                        armId: "b",
                        repetitionId: "r0",
                    },
                ],
            };
            (campaign.budgets as { trials: number }).trials = 2;
        });
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, true, summary.problems.join("; "));
        assert.deepEqual(summary.judged, ["a-useful", "b-useful"]);
        assert.notEqual(selected(root, "a-useful"), null);
        assert.notEqual(selected(root, "b-useful"), null);
    });

    it("refuses an unreadable attempt as an unresolved reservation", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const attempt = join(
            root,
            "evidence",
            "judgements",
            "useful-write",
            "attempt-001",
        );
        mkdirSync(attempt, { recursive: true });
        writeFileSync(
            join(attempt, "meta.json"),
            `${JSON.stringify({ judgementStatus: "started" })}\n`,
            "utf8",
        );

        // Act
        const summary = await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) =>
                /unresolved status/.test(problem),
            ),
            true,
        );
    });
});

describe("judge evidence guarantees", () => {
    const dirs: string[] = [];

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("never treats a fabricated selection object as judged", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        const slotDir = join(root, "evidence", "judgements", "useful-write");
        mkdirSync(slotDir, { recursive: true });
        writeFileSync(join(slotDir, "selection.json"), "{}\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");
        const status = statusOf(root);
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(status.judgement?.judged, 0);
        assert.equal(status.judgement?.pending, 2);
        assert.equal(
            status.judgement?.problems.some((problem) =>
                /selection/.test(problem),
            ),
            true,
        );
        assert.equal(closed.ok, false);
    });

    it("rejects a selected judgement whose stored verdict was changed", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const closed = closeCampaign(root, () => "2026-11-15T00:20:00.000Z");
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );
        const judgementPath = join(
            root,
            "evidence",
            "judgements",
            "useful-write",
            "attempt-001",
            "judgement.json",
        );
        const stored = JSON.parse(readFileSync(judgementPath, "utf8")) as {
            value: Record<string, unknown>;
        };
        stored.value.documentationOutcome = "transient";
        writeFileSync(
            judgementPath,
            `${JSON.stringify(stored, null, 2)}\n`,
            "utf8",
        );

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");
        const report = analyseCampaign(
            root,
            join(dir, "tampered-report"),
            () => "2026-11-15T00:40:00.000Z",
        );

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(
            report.ok,
            true,
            report.ok ? "" : report.problems.join("; "),
        );
        if (!report.ok) return;
        assert.equal(report.report.denominators.judged, 2);
        assert.equal(
            report.report.slots.find((slot) => slot.slotId === "useful-write")
                ?.judgement,
            null,
        );
    });

    it("leaves no open claim after a recovery", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);

        // Act
        await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    judgeResponses: (slotId, attemptId) =>
                        attemptId === "attempt-001"
                            ? "not json"
                            : judgement("useful-create"),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );

        // Assert
        assert.equal(existsSync(join(root, "judge")), false);
        assert.equal(existsSync(join(root, "recovery")), false);
        const judgeClaims = readClaims(join(root, "evidence"), "judge");
        const recoveryClaims = readClaims(join(root, "evidence"), "recovery");
        assert.equal(judgeClaims.length, 2);
        assert.equal(recoveryClaims.length, 1);
        assert.deepEqual(
            judgeClaims.map((claim) => claim.state),
            ["closed", "closed"],
        );
        assert.deepEqual(
            recoveryClaims.map((claim) => claim.state),
            ["closed"],
        );
    });

    it("keeps an interrupted recovery claim visible", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            { slotIds: ["restraint", "primary-failure"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:09:00.000Z",
            },
        );
        let judgeCalls = 0;

        // Act
        await assert.rejects(
            judgeCampaign(
                root,
                { slotIds: ["useful-write"] },
                {
                    runContainer: async (plan) => {
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
                        judgeCalls += 1;
                        if (judgeCalls === 1) {
                            return {
                                status: 0,
                                signal: null,
                                stdout: `${textEvent("not json")}\n`,
                                stderr: "",
                                timedOut: false,
                                error: null,
                            };
                        }
                        throw new Error("simulated interrupted recovery");
                    },
                    now: () => "2026-11-15T00:10:00.000Z",
                },
            ),
        );

        // Assert
        const recoveryClaims = readClaims(join(root, "evidence"), "recovery");
        assert.equal(recoveryClaims.length, 1);
        assert.equal(recoveryClaims[0]?.state, "spawned");
        assert.equal(statusOf(root).judgement?.unsettled, 2);
    });

    it("refuses closure with an interrupted recovery claim", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            { slotIds: ["restraint", "primary-failure"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:09:00.000Z",
            },
        );
        let judgeCalls = 0;
        await assert.rejects(
            judgeCampaign(
                root,
                { slotIds: ["useful-write"] },
                {
                    runContainer: async (plan) => {
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
                        judgeCalls += 1;
                        if (judgeCalls === 1) {
                            return {
                                status: 0,
                                signal: null,
                                stdout: `${textEvent("not json")}\n`,
                                stderr: "",
                                timedOut: false,
                                error: null,
                            };
                        }
                        throw new Error("simulated interrupted recovery");
                    },
                    now: () => "2026-11-15T00:10:00.000Z",
                },
            ),
        );

        // Act
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(closed.ok, false);
        assert.equal(
            closed.ok
                ? false
                : closed.problems.some((problem) => /unsettled/.test(problem)),
            true,
        );
    });

    it("refuses judgement when the executing tool differs from the freeze", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);

        // Act
        const summary = await judgeCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
                tool: { ...toolIdentity(), version: "99.0.0" },
            },
        );

        // Assert
        assert.equal(summary.ok, false);
        assert.equal(
            summary.problems.some((problem) => /tool/.test(problem)),
            true,
            summary.problems.join("; "),
        );
        assert.equal(
            existsSync(join(root, "evidence", "judgements", "useful-write")),
            false,
        );
    });

    it("does not expose either arm's instruction canary to the judge", async () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-judge-canary-"));
        dirs.push(dir);
        cpSync(FIXTURE, dir, { recursive: true });
        rmSync(join(dir, "workspace", "AGENTS.md"), { force: true });
        writeFileSync(join(dir, "arm-a.md"), "CANARY_ARM_A\n", "utf8");
        writeFileSync(join(dir, "arm-b.md"), "CANARY_ARM_B\n", "utf8");
        const campaignPath = join(dir, "campaign.json");
        const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
            subjects: unknown[];
            schedule: { slots: unknown[] };
            budgets: { trials: number; judgeAttempts: number };
        };
        campaign.subjects = [
            {
                armId: "a",
                instructions: [{ id: "a", path: "arm-a.md", as: "AGENTS.md" }],
            },
            {
                armId: "b",
                instructions: [{ id: "b", path: "arm-b.md", as: "AGENTS.md" }],
            },
        ];
        campaign.schedule.slots = [
            {
                slotId: "a-useful",
                caseId: "useful-write",
                armId: "a",
                repetitionId: "r0",
            },
            {
                slotId: "b-useful",
                caseId: "useful-write",
                armId: "b",
                repetitionId: "r0",
            },
        ];
        campaign.budgets.trials = 2;
        writeFileSync(
            campaignPath,
            `${JSON.stringify(campaign, null, 2)}\n`,
            "utf8",
        );
        const root = join(dir, "root");
        const prepared = prepareCampaign(campaignPath, root);
        assert.equal(prepared.ok, true);
        const frozen = await freezeCampaign(
            root,
            fakeImage as typeof runCommand,
        );
        assert.equal(frozen.ok, true);
        await runCampaign(
            root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:00:00.000Z",
            },
        );

        // Act
        const packetA = buildJudgePacketForSlot(root, "a-useful");
        const packetB = buildJudgePacketForSlot(root, "b-useful");

        // Assert
        assert.equal(
            packetA.ok,
            true,
            packetA.ok ? "" : packetA.problems.join("; "),
        );
        assert.equal(
            packetB.ok,
            true,
            packetB.ok ? "" : packetB.problems.join("; "),
        );
        if (!packetA.ok || !packetB.ok) return;
        assert.equal(packetA.packet.includes("CANARY_ARM_A"), false);
        assert.equal(packetA.packet.includes("CANARY_ARM_B"), false);
        assert.equal(packetB.packet.includes("CANARY_ARM_A"), false);
        assert.equal(packetB.packet.includes("CANARY_ARM_B"), false);
        assert.equal(packetA.packet, packetB.packet);
    });
});

describe("judge packet binding", () => {
    const dirs: string[] = [];

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    /** A root with every slot judged validly. */
    async function judgedRoot(): Promise<{ dir: string; root: string }> {
        const fixture = await campaignRoot();
        dirs.push(fixture.dir);
        await judgeCampaign(
            fixture.root,
            {},
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        return fixture;
    }

    /** The slot and selected attempt packet paths. */
    function packets(root: string, slotId: string, attemptId: string) {
        return {
            slot: join(root, "evidence", "judgements", slotId, "packet.md"),
            attempt: join(
                root,
                "evidence",
                "judgements",
                slotId,
                attemptId,
                "packet.md",
            ),
        };
    }

    it("rejects a changed slot packet", async () => {
        // Arrange
        const { root } = await judgedRoot();
        const path = packets(root, "useful-write", "attempt-001");
        writeFileSync(path.slot, "changed slot packet\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");
        const status = statusOf(root);
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(status.judgement?.judged, 2);
        assert.equal(
            status.judgement?.problems.some((problem) =>
                /packet/.test(problem),
            ),
            true,
        );
        assert.equal(closed.ok, false);
    });

    it("rejects a changed attempt packet", async () => {
        // Arrange
        const { root } = await judgedRoot();
        const path = packets(root, "useful-write", "attempt-001");
        writeFileSync(path.attempt, "changed attempt packet\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(
            checked.ok
                ? false
                : checked.problems.some((problem) => /packet/.test(problem)),
            true,
        );
    });

    it("rejects changed packets in both locations", async () => {
        // Arrange
        const { root } = await judgedRoot();
        const path = packets(root, "useful-write", "attempt-001");
        writeFileSync(path.slot, "changed together\n", "utf8");
        writeFileSync(path.attempt, "changed together\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");

        // Assert
        assert.equal(checked.ok, false);
    });

    it("rejects missing packets", async () => {
        // Arrange
        const { root } = await judgedRoot();
        const path = packets(root, "useful-write", "attempt-001");
        rmSync(path.slot, { force: true });
        rmSync(path.attempt, { force: true });

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(
            checked.ok
                ? false
                : checked.problems.some((problem) => /missing/.test(problem)),
            true,
        );
    });

    it("rejects changed underlying answer evidence", async () => {
        // Arrange
        const { dir, root } = await judgedRoot();
        const answer = join(
            root,
            "evidence",
            "trials",
            "useful-write",
            "answer.md",
        );
        writeFileSync(answer, "A different answer.\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");
        const closed = closeCampaign(root, () => "2026-11-15T00:30:00.000Z");

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(
            checked.ok
                ? false
                : checked.problems.some((problem) => /evidence/.test(problem)),
            true,
        );
        assert.equal(closed.ok, false);
        void dir;
    });

    it("does not hide corruption of a selected recovery behind the failed first attempt", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        dirs.push(dir);
        await judgeCampaign(
            root,
            { slotIds: ["restraint", "primary-failure"] },
            {
                runContainer: container({}),
                now: () => "2026-11-15T00:09:00.000Z",
            },
        );
        await judgeCampaign(
            root,
            { slotIds: ["useful-write"] },
            {
                runContainer: container({
                    judgeResponses: (slotId, attemptId) =>
                        attemptId === "attempt-001"
                            ? "not json"
                            : judgement("useful-create"),
                }),
                now: () => "2026-11-15T00:10:00.000Z",
            },
        );
        const closed = closeCampaign(root, () => "2026-11-15T00:20:00.000Z");
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );
        const path = packets(root, "useful-write", "attempt-002");
        writeFileSync(path.attempt, "corrupted recovery packet\n", "utf8");

        // Act
        const checked = checkedSelectionForSlot(root, "useful-write");
        const status = statusOf(root);
        const report = analyseCampaign(
            root,
            join(dir, "recovery-corrupt-report"),
            () => "2026-11-15T00:40:00.000Z",
        );

        // Assert
        assert.equal(checked.ok, false);
        assert.equal(status.judgement?.judged, 2);
        assert.equal(status.judgement?.failed, 0);
        assert.equal(
            status.judgement?.problems.some((problem) =>
                /packet/.test(problem),
            ),
            true,
        );
        assert.equal(
            report.ok,
            true,
            report.ok ? "" : report.problems.join("; "),
        );
        if (!report.ok) return;
        assert.equal(report.report.denominators.judged, 2);
        assert.equal(
            report.report.slots
                .find((slot) => slot.slotId === "useful-write")
                ?.judgeProblems.some((problem) => /packet/.test(problem)),
            true,
        );
    });
});
