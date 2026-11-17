import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    chmodSync,
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
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { analyseCampaign } from "../../src/reporting/report.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"f".repeat(64)}`;

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
        sessionID: "ses_report",
        messageID: "msg_report",
        part: { type: "text", text },
    });
}

/** A silent subject for every slot. */
const container = async (_plan: ContainerPlan): Promise<CommandResult> => ({
    status: 0,
    signal: null,
    stdout: `${textEvent("No activation.")}\n`,
    stderr: "",
    timedOut: false,
    error: null,
});

/** A closed, assessed campaign root. */
async function closedRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-report-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(root, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    const ran = await runCampaign(root, {}, { runContainer: container });
    assert.equal(ran.ok, true, ran.problems.join("; "));
    const assessed = assessCampaign(root, {
        now: () => "2026-11-17T00:00:00.000Z",
    });
    assert.equal(assessed.ok, true, assessed.problems.join("; "));
    const closed = closeCampaign(root);
    assert.equal(closed.ok, true, closed.ok ? "" : closed.problems.join("; "));
    return { dir, root };
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

describe("report destination containment", () => {
    const dirs: string[] = [];
    const closed = async () => {
        const made = await closedRoot();
        dirs.push(made.dir);
        return made.root;
    };

    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a direct evidence child", async () => {
        // Arrange
        const root = await closed();
        const out = join(root, "evidence", "review-output");

        // Act
        const result = analyseCampaign(root, out);

        // Assert
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.problems.join("; "), /protected evidence/);
        assert.equal(existsSync(out), false);
    });

    it("refuses a prepared-input child and a normalised escape", async () => {
        // Arrange
        const root = await closed();
        const preparedChild = join(root, "prepare", "reports");
        const normalised = join(root, "reports", "..", "evidence", "out");

        // Act
        const one = analyseCampaign(root, preparedChild);
        const two = analyseCampaign(root, normalised);

        // Assert
        assert.equal(one.ok, false);
        assert.equal(two.ok, false);
        assert.equal(existsSync(preparedChild), false);
        assert.equal(existsSync(join(root, "evidence", "out")), false);
    });

    it("refuses an alias through a symlink into protected evidence", async () => {
        // Arrange
        const root = await closed();
        const alias = join(root, "out-link");
        symlinkSync(join(root, "evidence"), alias);
        const out = join(alias, "descendant", "review");

        // Act
        const result = analyseCampaign(root, out);

        // Assert
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.problems.join("; "), /protected evidence/);
        assert.equal(existsSync(join(root, "evidence", "descendant")), false);
    });

    it("writes a legal sibling reports directory, including spaces", async () => {
        // Arrange
        const root = await closed();
        const out = join(root, "reports", "final review");

        // Act
        const result = analyseCampaign(root, out);

        // Assert
        assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
        assert.equal(existsSync(join(out, "report.json")), true);
        assert.equal(existsSync(join(out, "report.md")), true);
    });

    it("leaves protected evidence byte-identical on refusal", async () => {
        // Arrange
        const root = await closed();
        const before = snapshot(join(root, "evidence"));

        // Act
        analyseCampaign(root, join(root, "evidence", "nested", "report"));

        // Assert
        assert.equal(snapshot(join(root, "evidence")), before);
    });

    it("leaves no completed report when publication fails", async () => {
        // Arrange
        const root = await closed();
        const parent = join(root, "readonly-parent");
        mkdirSync(parent);
        chmodSync(parent, 0o500);
        const out = join(parent, "report");
        try {
            // Act
            const result = analyseCampaign(root, out);

            // Assert
            assert.equal(result.ok, false);
            assert.equal(existsSync(out), false);
        } finally {
            chmodSync(parent, 0o700);
        }
    });

    it("refuses to overwrite an existing report directory", async () => {
        // Arrange
        const root = await closed();
        const out = join(root, "reports", "existing");
        assert.equal(analyseCampaign(root, out).ok, true);

        // Act
        const second = analyseCampaign(root, out);

        // Assert
        assert.equal(second.ok, false);
        assert.match(second.ok ? "" : second.problems.join("; "), /never overwritten/);
    });
});
