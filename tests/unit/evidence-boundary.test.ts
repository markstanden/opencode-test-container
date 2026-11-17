import { after, describe, it } from "node:test";
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
import {
    loadPreparedManifest,
    prepareCampaign,
} from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign, trialDirectory } from "../../src/campaign/run.ts";
import { buildJudgePacketForSlot } from "../../src/campaign/judge.ts";
import {
    assessCampaign,
    assessmentPath,
    readAssessments,
} from "../../src/campaign/assess.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import { checkedAssessments } from "../../src/evidence/assessments.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"d".repeat(64)}`;
const SENTINEL = "HOST_ONLY_REVIEW_SENTINEL";

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
        sessionID: "ses_boundary",
        messageID: "msg_boundary",
        part: { type: "text", text },
    });
}

/** A trial container that writes the expected document for useful-write. */
function trialContainer(): (plan: ContainerPlan) => Promise<CommandResult> {
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
        const title = plan.argv[plan.argv.indexOf("--title") + 1] ?? "";
        if (title.endsWith("-useful-write")) {
            const mount = plan.mounts.find(
                (entry) => entry.target === "/workspace",
            );
            assert.notEqual(mount, undefined);
            mkdirSync(
                join((mount as { source: string }).source, "docs", "notes"),
                {
                    recursive: true,
                },
            );
            writeFileSync(
                join(
                    (mount as { source: string }).source,
                    "docs",
                    "notes",
                    "otel.md",
                ),
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
}

/** A frozen, run campaign root. */
async function runRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-boundary-"));
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
    const summary = await runCampaign(
        root,
        {},
        {
            runContainer: trialContainer(),
            now: () => "2026-11-15T00:00:00.000Z",
        },
    );
    assert.equal(summary.ok, true, summary.problems.join("; "));
    return { dir, root };
}

/** An external directory holding the sentinel. */
function external(): string {
    const dir = mkdtempSync(join(tmpdir(), "otc-host-"));
    writeFileSync(join(dir, "review.md"), `${SENTINEL}\n`, "utf8");
    return dir;
}

describe("workspace containment at the judge boundary", () => {
    const temp: string[] = [];

    after(() => {
        for (const dir of temp) rmSync(dir, { recursive: true, force: true });
    });

    it("refuses an external lake-root symlink before a packet is built", async () => {
        // Arrange
        const { dir, root } = await runRoot();
        const host = external();
        temp.push(dir, host);
        const workspace = join(
            trialDirectory(root, "useful-write"),
            "workspace",
        );
        rmSync(join(workspace, "docs"), { recursive: true, force: true });
        symlinkSync(host, join(workspace, "docs"));

        // Act
        const packet = buildJudgePacketForSlot(root, "useful-write");

        // Assert
        assert.equal(packet.ok, false);
        const problems = packet.ok ? "" : packet.problems.join("; ");
        assert.match(problems, /symlink|outside/);
        assert.equal(problems.includes(SENTINEL), false);
    });

    it("refuses an external file symlink at the expected document", async () => {
        // Arrange
        const { dir, root } = await runRoot();
        const host = external();
        temp.push(dir, host);
        const document = join(
            trialDirectory(root, "useful-write"),
            "workspace",
            "docs",
            "notes",
            "otel.md",
        );
        rmSync(document, { force: true });
        symlinkSync(join(host, "review.md"), document);

        // Act
        const packet = buildJudgePacketForSlot(root, "useful-write");

        // Assert
        assert.equal(packet.ok, false);
        assert.match(
            packet.ok ? "" : packet.problems.join("; "),
            /outside|special file/,
        );
    });

    it("refuses assessment when the workspace escapes, and never passes restraint", async () => {
        // Arrange
        const { dir, root } = await runRoot();
        const host = external();
        temp.push(dir, host);
        const workspace = join(trialDirectory(root, "restraint"), "workspace");
        rmSync(join(workspace, "docs"), { recursive: true, force: true });
        symlinkSync(host, join(workspace, "docs"));

        // Act
        const assessed = assessCampaign(root, {
            now: () => "2026-11-15T00:05:00.000Z",
        });
        const stored = readAssessments(root).find(
            (entry) => entry.slotId === "restraint",
        );

        // Assert
        assert.equal(stored?.validity, "invalid");
        assert.equal(stored?.outcome, "unknown");
        assert.equal(
            JSON.stringify(stored).includes(SENTINEL),
            false,
            "the host sentinel must not enter a stored assessment",
        );
        assert.equal(assessed.summary.unrun, 0);
    });

    it("still builds the packet and assesses an ordinary workspace", async () => {
        // Arrange
        const { dir, root } = await runRoot();
        temp.push(dir);

        // Act
        const packet = buildJudgePacketForSlot(root, "useful-write");
        assessCampaign(root, { now: () => "2026-11-15T00:05:00.000Z" });
        const stored = readAssessments(root).find(
            (entry) => entry.slotId === "restraint",
        );

        // Assert
        assert.equal(
            packet.ok,
            true,
            packet.ok ? "" : packet.problems.join("; "),
        );
        assert.equal(
            packet.ok && packet.packet.includes("OpenTelemetry"),
            true,
        );
        assert.equal(stored?.validity, "valid");
        assert.equal(stored?.outcome, "pass");
    });
});

describe("assessment binds every consumed input", () => {
    const temp: string[] = [];

    after(() => {
        for (const dir of temp) rmSync(dir, { recursive: true, force: true });
    });

    /** A run and assessed docs root. */
    async function assessed(): Promise<{ dir: string; root: string }> {
        const made = await runRoot();
        temp.push(made.dir);
        const result = assessCampaign(made.root, {
            now: () => "2026-11-15T00:05:00.000Z",
        });
        assert.equal(result.ok, true, result.problems.join("; "));
        return made;
    }

    /** The checked record for useful-write. */
    function checked(root: string) {
        const prepared = loadPreparedManifest(root);
        if (!prepared.ok) throw new Error(prepared.problem);
        return checkedAssessments({
            root,
            manifest: prepared.manifest,
            ledger: readLedger(root),
        });
    }

    /** The conflicts for one slot. */
    function conflicts(root: string): string {
        const record = checked(root).records.find(
            (entry) => entry.slotId === "useful-write",
        );
        assert.equal(record?.state, "conflicting");
        return record?.problems.join("; ") ?? "";
    }

    it("detects a changed primary-check record", async () => {
        // Arrange
        const { root } = await assessed();
        const path = join(
            trialDirectory(root, "useful-write"),
            "primary-check.json",
        );
        const value = JSON.parse(readFileSync(path, "utf8")) as Record<
            string,
            unknown
        >;

        // Act
        value.status = "fail";
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

        // Assert
        assert.match(conflicts(root), /primarySha256 changed/);
    });

    it("detects a deleted primary-check record", async () => {
        // Arrange
        const { root } = await assessed();

        // Act
        rmSync(
            join(trialDirectory(root, "useful-write"), "primary-check.json"),
        );

        // Assert
        assert.match(conflicts(root), /primarySha256 changed/);
    });

    it("detects a journal file appearing after assessment", async () => {
        // Arrange
        const { root } = await assessed();
        const trial = trialDirectory(root, "useful-write");

        // Act
        mkdirSync(join(trial, "journal"), { recursive: true });
        writeFileSync(
            join(trial, "journal", "docs-operations.jsonl"),
            "{}\n",
            "utf8",
        );

        // Assert
        assert.match(conflicts(root), /journalSha256 changed/);
    });

    it("detects a changed evaluated workspace document", async () => {
        // Arrange
        const { root } = await assessed();
        const path = join(
            trialDirectory(root, "useful-write"),
            "workspace",
            "docs",
            "notes",
            "otel.md",
        );

        // Act
        writeFileSync(
            path,
            `${readFileSync(path, "utf8")}\nchanged after assessment\n`,
            "utf8",
        );

        // Assert
        assert.match(conflicts(root), /workspaceSha256 changed/);
    });

    it("keeps a genuine historical record readable without a binding", async () => {
        // The genuine old-format fixture is covered in historical-assessment;
        // this asserts the current format still records every field.
        const { root } = await assessed();
        const value = JSON.parse(
            readFileSync(assessmentPath(root, "useful-write"), "utf8"),
        ) as { evidence?: Record<string, unknown> };
        assert.equal(typeof value.evidence?.primarySha256, "string");
        assert.equal(typeof value.evidence?.workspaceSha256, "string");
        assert.equal(typeof value.evidence?.workspaceSafe, "boolean");
    });
});
