import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, USAGE, parseArgs, parseArgsWithDefaults } from "../../src/cli/otc.ts";

describe("CLI source surface", () => {
    it("parses repeatable and comma-separated slot selectors", () => {
        // Act
        const options = parseArgs([
            "run",
            "--root",
            "/tmp/root",
            "--slot",
            "s1,s2",
            "--slot",
            "s3",
        ]);

        // Assert
        assert.equal(options.command, "run");
        assert.equal(options.root, "/tmp/root");
        assert.deepEqual(options.slots, ["s1", "s2", "s3"]);
    });

    it("keeps every documented command dispatchable", () => {
        // Act
        const documented = COMMANDS.filter((command) =>
            USAGE.includes(command),
        );

        // Assert
        assert.deepEqual(documented, [...COMMANDS]);
    });

    it("rejects an unknown option as usage error", () => {
        // Act / Assert
        assert.throws(() => parseArgs(["status", "--wat"]), /unknown option/);
    });

    it("keeps omission of the selector as the whole schedule", () => {
        // Act
        const options = parseArgs(["run", "--root", "/tmp/root"]);

        // Assert
        assert.deepEqual(options.slots, []);
        assert.equal(options.provided.includes("--slot"), false);
    });

    it("refuses an explicit empty, blank or malformed selector", () => {
        // Arrange
        const malformed = ["", " ", "s1,,s2", "s1, ", ",s1", "s1,s1"];

        // Act / Assert
        for (const value of malformed) {
            assert.throws(
                () =>
                    parseArgs(["run", "--root", "/tmp/root", "--slot", value]),
                /--slot/,
                `accepted selector ${JSON.stringify(value)}`,
            );
        }
    });

    it("refuses a flag the command does not define", () => {
        // Act / Assert
        assert.throws(
            () => parseArgs(["close", "--root", "/tmp/root", "--dry-run"]),
            /close does not accept --dry-run/,
        );
        assert.throws(
            () => parseArgs(["status", "--root", "/tmp/root", "--slot", "s1"]),
            /status does not accept --slot/,
        );
        assert.throws(
            () =>
                parseArgs(["delivery-check", "--root", "/tmp/root", "--json"]),
            /delivery-check does not accept --json/,
        );
    });

    it("accepts the documented flags for run, judge and assess", () => {
        // Act
        const run = parseArgs([
            "run",
            "--root",
            "/tmp/root",
            "--slot",
            "s1",
            "--passthrough",
            "TOKEN",
            "--dry-run",
            "--json",
        ]);
        const judge = parseArgs([
            "judge",
            "--root",
            "/tmp/root",
            "--dry-run",
            "--json",
        ]);
        const assess = parseArgs(["assess", "--root", "/tmp/root", "--json"]);

        // Assert
        assert.deepEqual(run.slots, ["s1"]);
        assert.equal(run.dryRun, true);
        assert.equal(judge.dryRun, true);
        assert.equal(assess.json, true);
    });

    it("parses with explicit defaults without disturbing argv or other calls", () => {
        // Arrange
        const argv = ["run", "--slot", "s1"];
        const original = [...argv];

        // Act
        const first = parseArgsWithDefaults(argv, {
            campaign: "campaign.json",
            root: "/tmp/root",
        });
        const second = parseArgsWithDefaults(argv, {
            campaign: null,
            root: null,
        });
        const overridden = parseArgsWithDefaults(["run", "--root", "/x"], {
            campaign: null,
            root: "default-root",
        });

        // Assert
        assert.deepEqual(argv, original);
        assert.equal(first.campaign, "campaign.json");
        assert.equal(first.root, "/tmp/root");
        assert.equal(second.campaign, null);
        assert.equal(second.root, null);
        assert.deepEqual(first.slots, ["s1"]);
        assert.deepEqual(second.slots, ["s1"]);
        assert.notEqual(first.slots, second.slots);
        assert.equal(overridden.root, "/x");
        assert.throws(
            () =>
                parseArgsWithDefaults(["run", "--root"], {
                    campaign: null,
                    root: null,
                }),
            /needs a value/,
        );
    });

    it("keeps the environment defaults on the public entry point", () => {
        // Arrange
        const campaign = process.env.OTC_CAMPAIGN;
        const root = process.env.OTC_ROOT;
        process.env.OTC_CAMPAIGN = "env-campaign.json";
        process.env.OTC_ROOT = "env-root";
        try {
            // Act
            const options = parseArgs(["status"]);

            // Assert
            assert.equal(options.campaign, "env-campaign.json");
            assert.equal(options.root, "env-root");
        } finally {
            if (campaign === undefined) delete process.env.OTC_CAMPAIGN;
            else process.env.OTC_CAMPAIGN = campaign;
            if (root === undefined) delete process.env.OTC_ROOT;
            else process.env.OTC_ROOT = root;
        }
    });
});
