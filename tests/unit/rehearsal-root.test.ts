import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rehearsalRoot } from "../../rehearsals/root.mts";

describe("rehearsal root", () => {
    it("creates a fresh temporary root when no argument is given", () => {
        // Arrange / Act
        const root = rehearsalRoot(undefined, "otc-root-test-");

        try {
            // Assert
            assert.ok(existsSync(root));
            assert.ok(root.startsWith(resolve(tmpdir())));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("accepts an absolute path inside the temporary directory", () => {
        // Arrange
        const inside = mkdtempSync(join(tmpdir(), "otc-root-test-"));

        try {
            // Act
            const root = rehearsalRoot(inside, "otc-root-test-");

            // Assert
            assert.equal(root, resolve(inside));
        } finally {
            rmSync(inside, { recursive: true, force: true });
        }
    });

    it("accepts the current working directory", () => {
        // Arrange / Act
        const root = rehearsalRoot(process.cwd(), "otc-root-test-");

        // Assert
        assert.equal(root, resolve(process.cwd()));
    });

    it("refuses a relative path", () => {
        // Arrange / Act / Assert
        assert.throws(() => rehearsalRoot("relative/root", "otc-root-test-"), {
            message: /absolute path/,
        });
    });

    it("refuses an absolute path outside the allowed bases", () => {
        // Arrange
        const outside = join(resolve("/"), "etc");

        // Act / Assert
        assert.throws(() => rehearsalRoot(outside, "otc-root-test-"), {
            message: /must be inside/,
        });
    });
});
