import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign, trialDirectory } from "../../src/campaign/run.ts";
import { assessCampaign, assessmentPath } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { statusOf } from "../../src/campaign/status.ts";
import { analyseCampaign } from "../../src/reporting/report.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"e".repeat(64)}`;

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
        sessionID: "ses_identity",
        messageID: "msg_text",
        part: { type: "text", text },
    });
}

/** One completed skill event. */
function skillEvent(): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: "ses_identity",
        messageID: "msg_tool",
        part: {
            type: "tool",
            id: "call_1",
            tool: "skill",
            state: {
                status: "completed",
                input: { id: "otel-helper" },
                output: '<skill_content name="otel-helper">body</skill_content>',
            },
        },
    });
}

/** A scripted container: s1 activates, s2/s3 stay silent. */
const container = async (plan: ContainerPlan): Promise<CommandResult> => {
    const title = plan.argv[plan.argv.indexOf("--title") + 1] ?? "";
    const slot = title.slice(title.lastIndexOf("-") + 1);
    const stdout =
        slot === "s1"
            ? `${skillEvent()}\n${textEvent("Instrumented.")}\n`
            : `${textEvent("No telemetry.")}\n`;
    return {
        status: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        error: null,
    };
};

/** A container whose subject never activates the target skill. */
const silent = async (plan: ContainerPlan): Promise<CommandResult> => {
    const title = plan.argv[plan.argv.indexOf("--title") + 1] ?? "";
    const slot = title.slice(title.lastIndexOf("-") + 1);
    return {
        status: 0,
        signal: null,
        stdout: `${textEvent(`No activation for ${slot}.`)}\n`,
        stderr: "",
        timedOut: false,
        error: null,
    };
};

/** A prepared, frozen campaign root. */
async function frozenRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-identity-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

/** Run selected slots. */
async function run(
    root: string,
    slotIds?: string[],
    runContainer: (plan: ContainerPlan) => Promise<CommandResult> = container,
): Promise<void> {
    const summary = await runCampaign(
        root,
        slotIds === undefined ? {} : { slotIds },
        {
            runContainer,
            now: () => "2026-11-17T00:00:00.000Z",
        },
    );
    assert.equal(summary.ok, true, summary.problems.join("; "));
}

/** Hash every file under a root. */
function snapshot(root: string): string {
    const lines: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(entry.parentPath, entry.name);
            if (entry.isDirectory()) walk(path);
            else {
                lines.push(
                    `${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
                );
            }
        }
    };
    walk(root);
    return lines.sort().join("\n");
}

/** Read one stored assessment. */
function record(root: string, slotId: string): Record<string, unknown> {
    return JSON.parse(
        readFileSync(assessmentPath(root, slotId), "utf8"),
    ) as Record<string, unknown>;
}

/** Rewrite one stored assessment. */
function rewrite(
    root: string,
    slotId: string,
    mutate: (value: Record<string, unknown>) => void,
): void {
    const value = record(root, slotId);
    mutate(value);
    writeFileSync(assessmentPath(root, slotId), JSON.stringify(value, null, 2));
}

/** Assessment ledger events for one slot. */
function assessmentEvents(root: string, slotId: string) {
    return readLedger(root).events.filter(
        (event) => event.event === "assessment" && event.slotId === slotId,
    );
}

describe("semantic assessment identity", () => {
    const dirs: string[] = [];
    const rootOf = async () => {
        const made = await frozenRoot();
        dirs.push(made.dir);
        return made.root;
    };

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("reuses an identical assessment and its first timestamp", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);

        // Act
        const first = assessCampaign(root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });
        const before = record(root, "s1");
        const second = assessCampaign(root, {
            now: () => "2026-11-17T00:30:00.000Z",
        });
        const after = record(root, "s1");

        // Assert
        assert.equal(first.ok, true, first.problems.join("; "));
        assert.equal(second.ok, true, second.problems.join("; "));
        assert.equal(after.assessedAt, "2026-11-17T00:00:00.000Z");
        assert.deepEqual(after, before);
        assert.equal(assessmentEvents(root, "s1").length, 1);
    });

    it("publishes one record when two processes assess the same slot", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        const script = join(root, "race-assess.mjs");
        writeFileSync(
            script,
            `import { existsSync } from "node:fs";
import { assessCampaign } from ${JSON.stringify(
                pathToFileURL(
                    join(HERE, "..", "..", "src", "campaign", "assess.ts"),
                ).href,
            )};
const [root, start] = process.argv.slice(2);
while (!existsSync(start)) await new Promise((again) => setTimeout(again, 5));
const result = assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
console.log(JSON.stringify(result));
`,
            "utf8",
        );
        const start = join(root, "start");
        const children = [0, 1].map(
            () =>
                new Promise<string>((done, fail) => {
                    const child = spawn(
                        process.execPath,
                        [script, root, start],
                        { stdio: ["ignore", "pipe", "pipe"] },
                    );
                    let stdout = "";
                    let stderr = "";
                    child.stdout.on("data", (chunk: Buffer) => {
                        stdout += String(chunk);
                    });
                    child.stderr.on("data", (chunk: Buffer) => {
                        stderr += String(chunk);
                    });
                    child.on("error", fail);
                    child.on("close", (code) =>
                        code === 0 ? done(stdout) : fail(new Error(stderr)),
                    );
                }),
        );

        // Act
        writeFileSync(start, "go\n", "utf8");
        const results = await Promise.all(children);

        // Assert
        for (const result of results) {
            const parsed = JSON.parse(result) as {
                ok: boolean;
                problems: string[];
            };
            assert.equal(parsed.ok, true, parsed.problems.join("; "));
        }
        assert.equal(assessmentEvents(root, "s1").length, 1);
        assert.equal(existsSync(assessmentPath(root, "s1")), true);
    });

    it("assesses an unsafe workspace entry as invalid without hanging", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        const workspace = join(trialDirectory(root, "s1"), "workspace");
        assert.equal(
            spawnSync("mkfifo", [join(workspace, "z-pipe")]).status,
            0,
        );
        symlinkSync("z-pipe", join(workspace, "a-link"));

        // Act
        const assessed = assessCampaign(root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });
        const stored = record(root, "s1");

        // Assert
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        assert.equal(stored.validity, "invalid");
        assert.equal(stored.outcome, "unknown");
        assert.match((stored.reasons as string[]).join("; "), /unsafe object/);
    });

    it("assesses a directory symlink in the workspace as invalid", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        const workspace = join(trialDirectory(root, "s1"), "workspace");
        mkdirSync(join(workspace, "z-dir"));
        symlinkSync("z-dir", join(workspace, "a-link"));

        // Act
        const assessed = assessCampaign(root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });
        const stored = record(root, "s1");

        // Assert
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        assert.equal(stored.validity, "invalid");
        assert.match((stored.reasons as string[]).join("; "), /unsafe object/);
    });

    it("blocks status when a workspace entry becomes unsafe after assessment", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
        const workspace = join(trialDirectory(root, "s1"), "workspace");
        assert.equal(
            spawnSync("mkfifo", [join(workspace, "z-pipe")]).status,
            0,
        );
        symlinkSync("z-pipe", join(workspace, "a-link"));

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(
            status.problems.join("; "),
            /workspace(Safe|Sha256) changed/,
        );
    });

    it("refuses a changed assessment when the evidence changed", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
        const before = readFileSync(assessmentPath(root, "s1"), "utf8");
        const events = join(trialDirectory(root, "s1"), "events.jsonl");
        writeFileSync(
            events,
            `${readFileSync(events, "utf8")}${textEvent("second answer")}\n`,
            "utf8",
        );

        // Act
        const assessed = assessCampaign(root, {
            now: () => "2026-11-17T00:30:00.000Z",
        });

        // Assert
        assert.equal(assessed.ok, false);
        assert.equal(readFileSync(assessmentPath(root, "s1"), "utf8"), before);
        assert.equal(assessmentEvents(root, "s1").length, 1);
    });

    it("writes nothing before a trial has run, and assesses after it does", async () => {
        // Arrange
        const root = await rootOf();

        // Act
        const early = assessCampaign(root);
        await run(root, ["s1"]);
        const later = assessCampaign(root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });

        // Assert
        assert.equal(early.ok, true);
        assert.equal(early.summary.assessed, 0);
        assert.equal(early.skipped.length, 3);
        assert.equal(existsSync(assessmentPath(root, "s1")), true);
        assert.equal(later.summary.assessed, 1);
        assert.equal(later.summary.pass, 1);
    });

    it("leaves an in-flight slot unassessed", async () => {
        // Arrange
        const root = await rootOf();
        mkdirSync(trialDirectory(root, "s1"), { recursive: true });
        writeFileSync(
            join(trialDirectory(root, "s1"), "launch.json"),
            "{}\n",
            "utf8",
        );

        // Act
        const assessed = assessCampaign(root, { slotIds: ["s1"] });

        // Assert
        assert.equal(
            assessed.skipped.join("; "),
            "slot s1 is in flight; no assessment written",
        );
        assert.equal(existsSync(assessmentPath(root, "s1")), false);
    });

    it("assesses completed slots while leaving unrun slots derived", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);

        // Act
        const assessed = assessCampaign(root);

        // Assert
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        assert.equal(assessed.summary.assessed, 1);
        assert.equal(assessed.skipped.length, 2);
        assert.equal(existsSync(assessmentPath(root, "s2")), false);
    });

    it("refuses closure for a completed slot with no assessment", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);

        // Act
        const refused = closeCampaign(root);
        assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
        const closed = closeCampaign(root);

        // Assert
        assert.equal(refused.ok, false);
        assert.match(
            refused.ok ? "" : refused.problems.join("; "),
            /no checked assessment/,
        );
        assert.equal(
            closed.ok,
            true,
            closed.ok ? "" : closed.problems.join("; "),
        );
    });

    it("treats a post-close identical assessment as a read-only result", async () => {
        // Arrange
        const root = await rootOf();
        await run(root);
        assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
        assert.equal(closeCampaign(root).ok, true);
        const before = snapshot(join(root, "evidence"));

        // Act
        const assessed = assessCampaign(root, {
            now: () => "2026-11-17T01:00:00.000Z",
        });

        // Assert
        assert.equal(assessed.ok, true, assessed.problems.join("; "));
        assert.equal(assessed.summary.assessed, 3);
        assert.equal(snapshot(join(root, "evidence")), before);
    });

    it("refuses a post-close request that needs new evidence", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        assessCampaign(root, { now: () => "2026-11-17T00:00:00.000Z" });
        assert.equal(closeCampaign(root).ok, true);
        const events = join(trialDirectory(root, "s1"), "events.jsonl");
        writeFileSync(
            events,
            `${readFileSync(events, "utf8")}${textEvent("changed")}\n`,
            "utf8",
        );
        const before = snapshot(join(root, "evidence"));

        // Act
        const assessed = assessCampaign(root);

        // Assert
        assert.equal(assessed.ok, false);
        assert.equal(snapshot(join(root, "evidence")), before);
    });

    it("refuses a partial publication without leaving a record", async () => {
        // Arrange
        const root = await rootOf();
        await run(root, ["s1"]);
        const directory = join(root, "evidence", "assessments");
        mkdirSync(directory, { recursive: true });
        // A directory where the record file must go makes the atomic link fail.
        mkdirSync(assessmentPath(root, "s1"), { recursive: true });

        // Act
        const assessed = assessCampaign(root);

        // Assert
        assert.equal(assessed.ok, false);
        assert.equal(
            readdirSync(directory).some((name) => name.endsWith(".tmp")),
            false,
            "no orphan temporary record survives",
        );
    });
});

describe("tampered assessment evidence", () => {
    const dirs: string[] = [];
    const assessedRoot = async (
        runContainer?: (plan: ContainerPlan) => Promise<CommandResult>,
    ) => {
        const made = await frozenRoot();
        dirs.push(made.dir);
        await run(made.root, undefined, runContainer);
        assessCampaign(made.root, {
            now: () => "2026-11-17T00:00:00.000Z",
        });
        return made.root;
    };

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    const refuses = (root: string) => {
        const status = statusOf(root);
        const closed = closeCampaign(root);
        const report = analyseCampaign(root, join(root, "reports", "final"));
        return { status, closed, report };
    };

    it("cannot improve totals by editing a failing outcome and its reasons", async () => {
        // Arrange
        const root = await assessedRoot(silent);
        assert.equal(statusOf(root).counts.fail, 1, "s1 legitimately fails");
        rewrite(root, "s1", (value) => {
            value.outcome = "pass";
            value.reasons = [];
        });

        // Act
        const { status, closed, report } = refuses(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(status.problems.join("; "), /ledger hash/);
        assert.equal(closed.ok, false);
        assert.equal(report.ok, false);
        assert.equal(status.counts.pass, 2, "the tampered slot is not counted");
    });

    it("cannot vanish from the denominator when the record is malformed", async () => {
        // Arrange
        const root = await assessedRoot();
        writeFileSync(assessmentPath(root, "s2"), "{ not json", "utf8");

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.equal(status.counts.assessed, 2);
        assert.match(status.problems.join("; "), /not readable JSON/);
        assert.equal(status.nextActions.length, 0);
    });

    it("rejects missing and extra fields", async () => {
        // Arrange
        const root = await assessedRoot();
        rewrite(root, "s2", (value) => {
            delete value.reasons;
            value.extra = true;
        });

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(status.problems.join("; "), /reasons|unexpected field/);
    });

    it("rejects a wrong campaign and slot identity", async () => {
        // Arrange
        const root = await assessedRoot();
        rewrite(root, "s1", (value) => {
            value.campaignId = "other-campaign";
            value.slotId = "s3";
        });

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        const problems = status.problems.join("; ");
        assert.match(problems, /campaignId/);
        assert.match(problems, /slotId/);
    });

    it("rejects an assessment whose source evidence drifted", async () => {
        // Arrange
        const root = await assessedRoot();
        rewrite(root, "s1", (value) => {
            (value.evidence as Record<string, unknown>).captureSha256 =
                "0".repeat(64);
        });

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(
            status.problems.join("; "),
            /source evidence captureSha256 changed/,
        );
    });

    it("refuses status, closure and reporting after prepared-input drift", async () => {
        // Arrange
        const root = await assessedRoot();
        const prompt = join(
            root,
            "prepare",
            "prompts",
            "positive-instrument.txt",
        );
        writeFileSync(
            prompt,
            `${readFileSync(prompt, "utf8")}drifted\n`,
            "utf8",
        );

        // Act
        const status = statusOf(root);
        const closed = closeCampaign(root);
        const report = analyseCampaign(root, join(root, "reports", "drift"));

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(
            status.problems.join("; "),
            /prompts\/positive-instrument/,
        );
        assert.equal(closed.ok, false);
        assert.match(
            closed.ok ? "" : closed.problems.join("; "),
            /delivery check failed/,
        );
        assert.equal(report.ok, false);
    });

    it("refuses a report over a tampered assessment after closure", async () => {
        // Arrange
        const root = await assessedRoot();
        assert.equal(closeCampaign(root).ok, true);
        rewrite(root, "s1", (value) => {
            value.reasons = ["tampered"];
        });

        // Act
        const report = analyseCampaign(root, join(root, "reports", "final"));

        // Assert
        assert.equal(report.ok, false);
        assert.match(
            report.ok ? "" : report.problems.join("; "),
            /ledger hash/,
        );
    });

    it("rejects a missing and a duplicate ledger binding", async () => {
        // Arrange
        const missing = await assessedRoot();
        const text = readFileSync(
            join(missing, "evidence", "ATTEMPTS.jsonl"),
            "utf8",
        )
            .split("\n")
            .filter((line) => {
                if (line.trim() === "") return false;
                const parsed = JSON.parse(line) as Record<string, unknown>;
                return !(
                    parsed.event === "assessment" && parsed.slotId === "s2"
                );
            })
            .join("\n");
        writeFileSync(
            join(missing, "evidence", "ATTEMPTS.jsonl"),
            `${text}\n`,
            "utf8",
        );
        const duplicate = await assessedRoot();
        const duplicateLedger = readFileSync(
            join(duplicate, "evidence", "ATTEMPTS.jsonl"),
            "utf8",
        );
        const ownBinding = duplicateLedger
            .split("\n")
            .find(
                (line) =>
                    line.includes('"assessment"') &&
                    line.includes('"slotId":"s2"'),
            );
        writeFileSync(
            join(duplicate, "evidence", "ATTEMPTS.jsonl"),
            `${duplicateLedger}${ownBinding ?? ""}\n`,
            "utf8",
        );

        // Act
        const missingStatus = statusOf(missing);
        const duplicateStatus = statusOf(duplicate);

        // Assert
        assert.match(missingStatus.problems.join("; "), /no ledger binding/);
        assert.match(
            duplicateStatus.problems.join("; "),
            /bound more than once/,
        );
    });

    it("rejects an unsupported evaluator version and an unexpected record", async () => {
        // Arrange
        const root = await assessedRoot();
        rewrite(root, "s1", (value) => {
            value.evaluatorVersion = 99;
        });
        writeFileSync(
            join(root, "evidence", "assessments", "ghost.json"),
            "{}\n",
            "utf8",
        );

        // Act
        const status = statusOf(root);

        // Assert
        assert.equal(status.state, "blocked");
        assert.match(
            status.problems.join("; "),
            /unsupported evaluator version/,
        );
        assert.match(
            status.problems.join("; "),
            /unexpected assessment record/,
        );
    });
});
