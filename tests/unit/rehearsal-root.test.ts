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

    it("accepts a directory below the current working directory", () => {
        // Arrange
        const child = resolve(process.cwd(), "otc-root-test-child");

        // Act
        const root = rehearsalRoot(child, "otc-root-test-");

        // Assert
        assert.equal(root, child);
    });

    it("refuses the current working directory itself", () => {
        // Arrange / Act / Assert
        // The rehearsal deletes its root recursively, so a base itself must be
        // refused even though it is "inside" the allowed area.
        assert.throws(() => rehearsalRoot(process.cwd(), "otc-root-test-"), {
            message: /strict subdirectory/,
        });
    });

    it("refuses the temporary directory itself", () => {
        // Arrange / Act / Assert
        assert.throws(
            () => rehearsalRoot(resolve(tmpdir()), "otc-root-test-"),
            {
                message: /strict subdirectory/,
            },
        );
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
            message: /strict subdirectory/,
        });
    });
});
