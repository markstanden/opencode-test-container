import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, USAGE, parseArgs } from "../../src/cli/otc.ts";

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
});
