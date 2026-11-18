import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

    it("exits non-zero and recommends nothing for a corrupt ledger", () => {
        // Arrange
        const root = join(work, "corrupt-ledger-root");
        const prepared = otc(
            ["prepare", "--campaign", campaignPath, "--root", root],
            work,
        );
        assert.equal(prepared.status, 0, prepared.stderr);
        mkdirSync(join(root, "evidence"), { recursive: true });
        writeFileSync(
            join(root, "evidence", "ATTEMPTS.jsonl"),
            "{broken\n",
            "utf8",
        );

        // Act
        const result = otc(["status", "--root", root, "--json"], work);

        // Assert
        assert.equal(result.status, 1);
        const parsed = JSON.parse(result.stdout) as {
            state: string;
            nextActions: unknown[];
            problems: string[];
        };
        assert.equal(parsed.state, "blocked");
        assert.deepEqual(parsed.nextActions, []);
        assert.match(parsed.problems.join("; "), /not JSON|malformed/);
    });

    it("rejects an unknown slot selector before dispatch", () => {
        // Arrange
        const root = join(work, "unknown-slot-root");
        const prepared = otc(
            ["prepare", "--campaign", campaignPath, "--root", root],
            work,
        );
        assert.equal(prepared.status, 0, prepared.stderr);
        const manifest = readFileSync(
            join(root, "prepare", "manifest.json"),
            "utf8",
        );

        // Act
        const result = otc(
            ["run", "--root", root, "--slot", "no-such-slot"],
            work,
        );

        // Assert
        assert.equal(result.status, 2);
        assert.match(result.stderr, /unknown slotId no-such-slot/);
        assert.equal(
            readFileSync(join(root, "prepare", "manifest.json"), "utf8"),
            manifest,
        );
        assert.equal(
            existsSync(join(root, "evidence", "ATTEMPTS.jsonl")),
            false,
        );
    });
    it("refuses per-command flags and bad selectors without touching the ledger", () => {
        // Arrange: a root whose ledger is a sentinel we can compare byte for byte.
        const root = join(work, "intent-root");
        mkdirSync(join(root, "evidence"), { recursive: true });
        const ledger = join(root, "evidence", "ATTEMPTS.jsonl");
        const sentinel = '{"event":"sentinel"}\n';
        writeFileSync(ledger, sentinel, "utf8");
        const attempts = [
            ["run", "--root", root, "--slot", ""],
            ["run", "--root", root, "--slot", "s1,,"],
            ["judge", "--root", root, "--slot", "  "],
            ["close", "--root", root, "--dry-run"],
            ["assess", "--root", root, "--out", join(work, "x")],
        ];

        // Act / Assert
        for (const args of attempts) {
            const result = otc(args, work);
            assert.equal(
                result.status,
                2,
                `${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`,
            );
            assert.equal(
                readFileSync(ledger, "utf8"),
                sentinel,
                `${args.join(" ")} changed the ledger`,
            );
            assert.equal(existsSync(join(root, "evidence", "trials")), false);
        }
    });

    it("accepts an omitted selector as the whole schedule", () => {
        // Arrange
        const root = join(work, "omitted-selector-root");
        const prepared = otc(
            ["prepare", "--campaign", campaignPath, "--root", root],
            work,
        );
        assert.equal(prepared.status, 0, prepared.stderr);

        // Act: no freeze, so the run refuses operationally; the point is that
        // the selector was not rejected as malformed.
        const result = otc(["run", "--root", root, "--dry-run"], work);

        // Assert
        assert.doesNotMatch(result.stderr, /--slot/);
        assert.match(result.stderr, /frozen|freeze/);
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
                Array.isArray(parsed)
                    ? parsed
                    : Object.values(parsed as Record<string, unknown>)
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
            // The installed binary refuses command intent before any read,
            // claim or mutation, whatever the ledger already holds.
            const probe = join(consumer, "intent probe");
            mkdirSync(join(probe, "evidence"), { recursive: true });
            const probeLedger = join(probe, "evidence", "ATTEMPTS.jsonl");
            const probeBytes = '{"event":"sentinel"}\n';
            writeFileSync(probeLedger, probeBytes, "utf8");
            for (const args of [
                ["run", "--root", probe, "--slot", ""],
                ["judge", "--root", probe, "--slot", "s1,,"],
                ["close", "--root", probe, "--dry-run"],
            ]) {
                const refused = spawnSync(binary, args, {
                    cwd: consumer,
                    encoding: "utf8",
                });
                assert.equal(
                    refused.status,
                    2,
                    `${args.join(" ")}: ${refused.stderr}`,
                );
                assert.equal(readFileSync(probeLedger, "utf8"), probeBytes);
            }
            // The supported checked reader is importable from the package root
            // as ESM, and reads a real prepared root.
            const script = join(consumer, "check-assessments.mjs");
            writeFileSync(
                script,
                [
                    'import { checkedAssessments, loadPreparedManifest, readLedger, readAssessments } from "@markstanden/opencode-test-container";',
                    "const root = process.argv[2];",
                    "const prepared = loadPreparedManifest(root);",
                    "const checked = checkedAssessments({ root, manifest: prepared.manifest, ledger: readLedger(root) });",
                    "process.stdout.write(JSON.stringify({ ok: prepared.ok, records: checked.records.map((entry) => entry.state), supported: typeof checkedAssessments, deprecated: typeof readAssessments }));",
                ].join("\n"),
                "utf8",
            );
            const checkedImport = spawnSync(process.execPath, [script, root], {
                cwd: consumer,
                encoding: "utf8",
            });
            assert.equal(checkedImport.status, 0, checkedImport.stderr);
            const checkedJson = JSON.parse(checkedImport.stdout) as {
                ok: boolean;
                records: string[];
                supported: string;
                deprecated: string;
            };
            assert.equal(checkedJson.ok, true);
            assert.deepEqual(checkedJson.records, [
                "missing",
                "missing",
                "missing",
            ]);
            assert.equal(checkedJson.supported, "function");
            assert.equal(checkedJson.deprecated, "function");

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

            // The shipped rate summariser must run from the installed tarball,
            // with no repository path, against a report in the consumer cwd.
            const ratesReport = join(consumer, "rates-report.json");
            const quiet = (index: number) => ({
                slotId: `near-r${String(index)}`,
                caseId: "negative-near-miss",
                armId: "skill-only",
                repetitionId: `r${String(index)}`,
                expected: "no-activation",
                observed: "no-invocation",
                validity: "valid",
                outcome: "pass",
            });
            writeFileSync(
                ratesReport,
                `${JSON.stringify({ slots: [quiet(0), quiet(1), quiet(2)] })}\n`,
                "utf8",
            );
            const rates = spawnSync(
                process.execPath,
                [
                    join(
                        consumer,
                        "node_modules",
                        "@markstanden",
                        "opencode-test-container",
                        "examples",
                        "reporting",
                        "rates.mjs",
                    ),
                    ratesReport,
                ],
                { cwd: consumer, encoding: "utf8" },
            );
            assert.equal(rates.status, 0, rates.stderr);
            assert.match(
                rates.stdout,
                /\| negative-near-miss \| skill-only \| no-activation \| 3\/3 \| 0\/3 \| 3\/3 \|/,
                "the installed summariser did not report activation and pass separately",
            );
        } finally {
            rmSync(consumer, { recursive: true, force: true });
            rmSync(stage, { recursive: true, force: true });
        }
    });
});
