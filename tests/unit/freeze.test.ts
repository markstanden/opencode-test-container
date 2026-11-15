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
import { deliveryCheck, freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";
import { loadCampaignBundle } from "../../src/contracts/validate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

/** A fake image resolver. */
const fakeImage = async (): Promise<CommandResult> => ({
    status: 0,
    signal: null,
    stdout: "opencode v2.2.6\n",
    stderr: "",
    timedOut: false,
    error: null,
});

/** A fake inspect that still resolves the image identity. */
const fakeRun = async (
    _command: string,
    args: readonly string[],
): Promise<CommandResult> => {
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
    return fakeImage();
};

/** Copy the fixture into a disposable directory. */
function fixture(): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-freeze-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return { dir, campaignPath: join(dir, "campaign.json") };
}

/** Prepare and freeze a fixture campaign. */
async function frozenFixture(): Promise<{ dir: string; root: string }> {
    const { dir, campaignPath } = fixture();
    const root = join(dir, "root");
    const prepared = prepareCampaign(campaignPath, root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeRun as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

describe("freeze and isolation", () => {
    it("records a declared suite hash and refuses drift", () => {
        const { dir, campaignPath } = fixture();
        const campaign = JSON.parse(
            readFileSync(campaignPath, "utf8"),
        ) as Record<string, unknown>;
        const suite = campaign.suite as Record<string, unknown>;
        suite.sha256 = "0".repeat(64);
        writeFileSync(
            campaignPath,
            `${JSON.stringify(campaign, null, 2)}\n`,
            "utf8",
        );
        const loaded = loadCampaignBundle(campaignPath);
        assert.equal(loaded.ok, false);
        assert.ok(
            loaded.ok
                ? false
                : loaded.problems.some((problem) =>
                      problem.includes("sha256 mismatch"),
                  ),
        );
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a symlink that escapes the subject root", () => {
        const { dir, campaignPath } = fixture();
        symlinkSync(
            "/etc/passwd",
            join(dir, "skills", "otel-helper", "escape"),
        );
        const prepared = prepareCampaign(campaignPath, join(dir, "root"));
        assert.equal(prepared.ok, false);
        assert.ok(
            prepared.ok
                ? false
                : prepared.problems.some((problem) =>
                      problem.includes("escapes"),
                  ),
        );
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a changed staged subject before freeze", async () => {
        const { dir, root } = await frozenFixture();
        const skill = join(
            root,
            "prepare",
            "subjects",
            "skill-only",
            "skills",
            "otel-helper",
            "SKILL.md",
        );
        writeFileSync(skill, "changed", "utf8");
        const frozen = await freezeCampaign(root, fakeRun as typeof runCommand);
        assert.equal(frozen.ok, false);
        assert.ok(
            frozen.ok
                ? false
                : frozen.problems.some((problem) =>
                      problem.includes("does not match"),
                  ),
        );
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a changed subject at delivery check", async () => {
        const { dir, root } = await frozenFixture();
        const skill = join(
            root,
            "prepare",
            "subjects",
            "skill-only",
            "skills",
            "otel-helper",
            "SKILL.md",
        );
        writeFileSync(skill, "changed", "utf8");
        const problems = deliveryCheck(root);
        assert.ok(problems.some((problem) => problem.includes("changed")));
        rmSync(dir, { recursive: true, force: true });
    });

    it("detects an added staged file", async () => {
        const { dir, root } = await frozenFixture();
        mkdirSync(join(root, "prepare", "subjects", "skill-only", "extra"), {
            recursive: true,
        });
        writeFileSync(
            join(
                root,
                "prepare",
                "subjects",
                "skill-only",
                "extra",
                "file.txt",
            ),
            "x",
            "utf8",
        );
        const problems = deliveryCheck(root);
        assert.ok(problems.some((problem) => problem.includes("added")));
        rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to prepare over an existing root", () => {
        const { dir, campaignPath } = fixture();
        mkdirSync(join(dir, "root"));
        const prepared = prepareCampaign(campaignPath, join(dir, "root"));
        assert.equal(prepared.ok, false);
        assert.ok(
            prepared.ok
                ? false
                : prepared.problems.some((problem) =>
                      problem.includes("fresh root"),
                  ),
        );
        rmSync(dir, { recursive: true, force: true });
    });
});
