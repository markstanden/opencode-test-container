import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign, deliveryCheck } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessDocsTrial } from "../../src/evaluators/docs/assess.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";
import type { DocsTaskCase } from "../../src/contracts/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

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

/** One completed text event. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_test",
        messageID: "msg_text",
        part: { type: "text", text },
    });
}

/** Copy the fixture campaign into a disposable directory. */
function fixtureCampaign(): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-primary-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return { dir, campaignPath: join(dir, "campaign.json") };
}

/** A fake container that answers trials and primary checks. */
function fakeContainer(
    options: {
        primaryStatus?: number;
        primaryTimedOut?: boolean;
        onTrial?: (plan: ContainerPlan) => void;
    } = {},
) {
    return async (plan: ContainerPlan): Promise<CommandResult> => {
        if (plan.argv[0] === "node") {
            const failing = plan.argv[1]?.includes("fail.mjs") === true;
            return {
                status: options.primaryStatus ?? (failing ? 3 : 0),
                signal: null,
                stdout: "checker stdout\n",
                stderr: failing ? "checker failed\n" : "",
                timedOut: options.primaryTimedOut ?? false,
                error: null,
            };
        }
        options.onTrial?.(plan);
        return {
            status: 0,
            signal: null,
            stdout: `${textEvent("Renamed the variable.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** Build a verified-journal trial directory for direct assessment. */
function assessedTrial(primary: Record<string, unknown> | null): string {
    const directory = mkdtempSync(join(tmpdir(), "otc-primary-assess-"));
    mkdirSync(join(directory, "journal"), { recursive: true });
    mkdirSync(join(directory, "workspace", "docs"), { recursive: true });
    writeFileSync(
        join(directory, "events.jsonl"),
        `${JSON.stringify({
            type: "text",
            sessionID: "ses_1",
            messageID: "msg_1",
            part: { type: "text", text: "Renamed." },
        })}\n`,
        "utf8",
    );
    writeFileSync(join(directory, "tools.jsonl"), "", "utf8");
    writeFileSync(
        join(directory, "journal", "docs-operations.jsonl"),
        "",
        "utf8",
    );
    writeFileSync(join(directory, "journal-key.txt"), "key", "utf8");
    writeFileSync(
        join(directory, "meta.json"),
        `${JSON.stringify({ captureValid: true, captureProblems: [], exit: 0, timedOut: false })}\n`,
        "utf8",
    );
    if (primary !== null) {
        writeFileSync(
            join(directory, "primary-check.json"),
            `${JSON.stringify(primary)}\n`,
            "utf8",
        );
    }
    return directory;
}

/** The docs case used by direct assessment. */
function primaryCase(): DocsTaskCase {
    return {
        caseId: "primary-failure",
        kind: "docs-task",
        prompt: "Rename one variable.",
        lakeRoot: "docs",
        expectedDocs: { kind: "none" },
        criterion: { minVerifiedCalls: 0 },
        primaryCheck: {
            id: "fixture",
            directory: "checkers",
            script: "fail.mjs",
        },
    };
}

/** Assess one prepared directory. */
function assess(directory: string) {
    return assessDocsTrial({
        campaignId: "c",
        slotId: "s",
        caseId: "primary-failure",
        armId: "a",
        repetitionId: "r0",
        testCase: primaryCase(),
        trialDir: directory,
        workspace: join(directory, "workspace"),
        prepared: new Map(),
        attemptId: "deterministic-s",
        assessedAt: "2026-11-15T00:00:00.000Z",
    });
}

describe("product primary check", () => {
    let dir = "";
    let root = "";
    let preparedChecks = "";

    before(async () => {
        const fixture = fixtureCampaign();
        dir = fixture.dir;
        root = join(dir, "root");
        preparedChecks = join(root, "prepare", "primary-checks");
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
        assert.equal(
            frozen.ok,
            true,
            frozen.ok ? "" : frozen.problems.join("; "),
        );
    });

    after(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("stages the checker outside the trial workspace", () => {
        // Arrange
        const checker = join(preparedChecks, "useful-write", "pass.mjs");

        // Act
        const inWorkspace = existsSync(
            join(root, "prepare", "workspaces", "useful-write", "checkers"),
        );

        // Assert
        assert.equal(existsSync(checker), true);
        assert.equal(inWorkspace, false);
    });

    it("freezes the staged checker payload identity", () => {
        // Arrange
        const manifest = JSON.parse(
            readFileSync(join(root, "prepare", "manifest.json"), "utf8"),
        ) as {
            primaryChecksSha256?: string;
            tool?: {
                name?: string;
                version?: string;
                evaluatorVersion?: number;
            };
        };

        // Act
        const problems = deliveryCheck(root);

        // Assert
        assert.match(manifest.primaryChecksSha256 ?? "", /^[0-9a-f]{64}$/);
        assert.equal(
            manifest.tool?.name,
            "@markstanden/opencode-test-container",
        );
        assert.equal(manifest.tool?.version, "0.1.0");
        assert.equal(manifest.tool?.evaluatorVersion, 1);
        assert.deepEqual(problems, []);
    });

    it("refuses delivery when the staged checker changes", () => {
        // Arrange
        const path = join(preparedChecks, "useful-write", "pass.mjs");
        const original = readFileSync(path, "utf8");
        writeFileSync(path, `${original}\n// changed\n`, "utf8");

        // Act
        const problems = deliveryCheck(root);

        // Assert
        assert.equal(
            problems.some((problem) =>
                /primary-checks\/useful-write: changed pass\.mjs/.test(problem),
            ),
            true,
            problems.join("; "),
        );
        writeFileSync(path, original, "utf8");
    });

    it("runs the checker in a separate no-network container with read-only evidence", async () => {
        // Arrange
        const plans: ContainerPlan[] = [];
        const execute = fakeContainer({
            onTrial: () => undefined,
        });

        // Act
        const summary = await runCampaign(
            root,
            { slotIds: ["primary-failure"] },
            {
                runContainer: async (plan) => {
                    plans.push(plan);
                    return execute(plan);
                },
            },
        );

        // Assert
        assert.equal(summary.ok, true, summary.problems.join("; "));
        const check = plans.find((plan) => plan.argv[0] === "node");
        assert.notEqual(check, undefined);
        const checker = check as ContainerPlan;
        assert.equal(checker.network, "none");
        assert.equal(checker.workdir, "/tmp");
        assert.deepEqual(
            checker.mounts.map((mount) => [mount.target, mount.readOnly]),
            [
                ["/live", true],
                ["/pristine", true],
                ["/checker", true],
            ],
        );
        assert.deepEqual(checker.argv.slice(0, 2), [
            "node",
            "/checker/fail.mjs",
        ]);
        const record = JSON.parse(
            readFileSync(
                join(
                    root,
                    "evidence",
                    "trials",
                    "primary-failure",
                    "primary-check.json",
                ),
                "utf8",
            ),
        ) as { status: string; id: string };
        assert.equal(record.status, "fail");
        assert.equal(record.id, "fail");
    });

    it("treats a checker failure as a failed criterion, not a pass", () => {
        // Arrange
        const directory = assessedTrial({
            schemaVersion: 1,
            id: "fixture",
            status: "fail",
            exit: 3,
        });

        // Act
        const result = assess(directory);

        // Assert
        assert.equal(result.validity, "valid");
        assert.equal(result.outcome, "fail");
        assert.equal(result.primary?.status, "fail");
        assert.equal(
            result.reasons.some((reason) =>
                /primary check fixture failed/.test(reason),
            ),
            true,
        );
    });

    it("treats a checker timeout as unknown, never pass or fail", () => {
        // Arrange
        const directory = assessedTrial({
            schemaVersion: 1,
            id: "fixture",
            status: "timeout",
            exit: null,
            reason: "timed out",
        });

        // Act
        const result = assess(directory);

        // Assert
        assert.equal(result.validity, "unknown");
        assert.equal(result.outcome, "unknown");
        assert.equal(result.primary?.status, "timeout");
    });

    it("treats a missing checker result as invalid evidence", () => {
        // Arrange
        const directory = assessedTrial(null);

        // Act
        const result = assess(directory);

        // Assert
        assert.equal(result.validity, "invalid");
        assert.equal(result.outcome, "unknown");
        assert.equal(
            result.reasons.some((reason) =>
                /has no recorded result/.test(reason),
            ),
            true,
        );
    });
});
