import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePackageInputs } from "../support/package-stage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const CLI = join(REPO, "dist", "cli", "otc.js");
const FIXTURE = join(REPO, "tests", "fixtures", "skill-basic");

/** Run the built CLI from an unrelated working directory. */
function otc(args: string[], cwd: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            OTC_CAMPAIGN: "",
            OTC_ROOT: "",
        },
    });
}

describe("installed-shape CLI", () => {
    let work = "";
    let campaignPath = "";

    before(() => {
        work = mkdtempSync(join(tmpdir(), "otc-cli-"));
        const fixture = join(work, "fixture");
        cpSync(FIXTURE, fixture, { recursive: true });
        campaignPath = join(fixture, "campaign.json");
    });

    after(() => {
        rmSync(work, { recursive: true, force: true });
    });

    it("prints help from an unrelated directory", () => {
        // Arrange
        const cwd = work;

        // Act
        const result = otc(["--help"], cwd);

        // Assert
        assert.equal(result.status, 0);
        assert.match(result.stdout, /otc — an isolated test sandbox/);
        assert.match(result.stdout, /delivery-check/);
        assert.match(result.stdout, /judge/);
    });

    it("prints a version", () => {
        const result = otc(["--version"], work);
        assert.equal(result.status, 0);
        assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
    });

    it("validates a campaign with quoted absolute paths", () => {
        const result = otc(
            ["validate", "--campaign", campaignPath, "--json"],
            work,
        );
        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.equal(parsed.ok, true);
        assert.equal(parsed.suiteId, "skill-basic");
        assert.equal(parsed.slots, 3);
    });

    it("prepares and observes status without writing on status", () => {
        const root = join(work, "campaign root");
        const prepared = otc(
            ["prepare", "--campaign", campaignPath, "--root", root],
            work,
        );
        assert.equal(prepared.status, 0, prepared.stderr);
        assert.equal(existsSync(join(root, "prepare", "manifest.json")), true);
        const before = readFileSync(
            join(root, "prepare", "manifest.json"),
            "utf8",
        );
        const status = otc(["status", "--root", root, "--json"], work);
        assert.equal(status.status, 0, status.stderr);
        const parsed = JSON.parse(status.stdout) as {
            state: string;
            nextActions: Array<{ command: string }>;
        };
        assert.equal(parsed.state, "prepared");
        assert.ok(parsed.nextActions[0]?.command.includes("otc freeze"));
        assert.equal(
            readFileSync(join(root, "prepare", "manifest.json"), "utf8"),
            before,
        );
    });

    it("refuses an unknown option with a usage error", () => {
        const result = otc(["status", "--wat"], work);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /unknown option/);
    });

    it("returns a blocked status for a missing root", () => {
        const result = otc(
            ["status", "--root", join(work, "absent"), "--json"],
            work,
        );
        assert.equal(result.status, 1);
        const parsed = JSON.parse(result.stdout) as { state: string };
        assert.equal(parsed.state, "blocked");
    });
});

describe("packaged consumer", () => {
    it("installs the tarball and runs the binary with no repository paths", () => {
        const consumer = mkdtempSync(join(tmpdir(), "otc consumer-"));
        const stage = stagePackageInputs(REPO);
        try {
            writeFileSync(
                join(consumer, "package.json"),
                `${JSON.stringify({ name: "otc-consumer", private: true, version: "1.0.0" }, null, 2)}\n`,
                "utf8",
            );
            // Pack the staged copy: prepack rebuilds *its* dist, never the
            // checkout's shared build output.
            const packed = spawnSync(
                "npm",
                ["pack", "--json", "--pack-destination", consumer],
                {
                    cwd: stage,
                    encoding: "utf8",
                },
            );
            assert.equal(packed.status, 0, packed.stderr);
            const parsed: unknown = JSON.parse(packed.stdout);
            const entries = (
                Array.isArray(parsed) ? parsed : Object.values(parsed)
            ) as Array<{ filename?: string }>;
            const filename = entries[0]?.filename;
            assert.equal(typeof filename, "string");
            const tarball = join(consumer, filename ?? "");
            assert.equal(existsSync(tarball), true);
            const installed = spawnSync(
                "npm",
                ["install", "--no-audit", "--no-fund", tarball],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(installed.status, 0, installed.stderr);
            const binary = join(consumer, "node_modules", ".bin", "otc");
            const help = spawnSync(binary, ["--help"], {
                cwd: consumer,
                encoding: "utf8",
            });
            assert.equal(help.status, 0, help.stderr);
            assert.match(help.stdout, /otc — an isolated test sandbox/);
            const fixture = join(consumer, "fixture");
            cpSync(FIXTURE, fixture, { recursive: true });
            const validate = spawnSync(
                binary,
                ["validate", "--campaign", join(fixture, "campaign.json")],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(validate.status, 0, validate.stderr);
            assert.match(validate.stdout, /skill-basic/);
            const root = join(consumer, "installed root");
            const prepared = spawnSync(
                binary,
                [
                    "prepare",
                    "--campaign",
                    join(fixture, "campaign.json"),
                    "--root",
                    root,
                ],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(prepared.status, 0, prepared.stderr);
            const status = spawnSync(
                binary,
                ["status", "--root", root, "--json"],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(status.status, 0, status.stderr);
            const statusJson = JSON.parse(status.stdout) as { state: string };
            assert.equal(statusJson.state, "prepared");
            const report = join(consumer, "installed-report");
            const replay = spawnSync(
                binary,
                [
                    "replay",
                    "--manifest",
                    join(
                        REPO,
                        "tests",
                        "fixtures",
                        "docs-parity",
                        "manifest.json",
                    ),
                    "--evidence-root",
                    join(REPO, "tests", "fixtures", "docs-parity", "evidence"),
                    "--out",
                    report,
                ],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(replay.status, 0, replay.stderr);
            assert.equal(
                existsSync(join(report, "analysis.json")),
                true,
                "installed CLI wrote the analysis",
            );
        } finally {
            rmSync(consumer, { recursive: true, force: true });
            rmSync(stage, { recursive: true, force: true });
        }
    });
});
