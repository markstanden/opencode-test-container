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
});
