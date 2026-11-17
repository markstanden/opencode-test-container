import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    changedInventoryPaths,
    inventory,
    inventoryDifferences,
    inventoryEntryDifferences,
} from "../../src/campaign/inventory.ts";

/** A temporary tree. */
function tree(): string {
    return mkdtempSync(join(tmpdir(), "otc-inventory-"));
}

/** Inventory a tree, asserting success. */
function entries(root: string) {
    const observed = inventory(root);
    assert.equal(observed.ok, true, observed.ok ? "" : observed.problem);
    return observed.ok ? observed.entries : [];
}

describe("inventory identity", () => {
    it("detects a link retargeted to identical bytes", () => {
        // Arrange
        const root = tree();
        try {
            writeFileSync(join(root, "a.md"), "same\n");
            writeFileSync(join(root, "b.md"), "same\n");
            symlinkSync("a.md", join(root, "link.md"));
            const before = entries(root);
            rmSync(join(root, "link.md"));
            symlinkSync("b.md", join(root, "link.md"));

            // Act
            const differences = inventoryDifferences(root, before);

            // Assert
            assert.deepEqual(differences, [
                "retargeted link link.md (a.md -> b.md)",
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("detects file-to-link and link-to-file changes", () => {
        // Arrange
        const root = tree();
        try {
            writeFileSync(join(root, "doc.md"), "same\n");
            writeFileSync(join(root, "target.md"), "same\n");
            const fileEntry = entries(root).find(
                (entry) => entry.path === "doc.md",
            );
            assert.notEqual(fileEntry, undefined);
            rmSync(join(root, "doc.md"));
            symlinkSync("target.md", join(root, "doc.md"));
            const linkEntry = entries(root)[0];
            assert.notEqual(linkEntry, undefined);

            // Act
            const forward = inventoryEntryDifferences(
                "doc.md",
                fileEntry!,
                linkEntry!,
            );
            const backward = inventoryEntryDifferences(
                "doc.md",
                linkEntry!,
                fileEntry!,
            );

            // Assert
            assert.match(forward.join("; "), /changed kind/);
            assert.match(backward.join("; "), /changed kind/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reports added, removed and retargeted links through the shared comparator", () => {
        // Arrange
        const root = tree();
        try {
            writeFileSync(join(root, "a.md"), "a\n");
            writeFileSync(join(root, "b.md"), "a\n");
            symlinkSync("a.md", join(root, "link.md"));
            const before = entries(root);
            rmSync(join(root, "link.md"));
            symlinkSync("b.md", join(root, "link.md"));
            writeFileSync(join(root, "new.md"), "new\n");

            // Act
            const changed = changedInventoryPaths(before, entries(root));

            // Assert
            assert.deepEqual(changed, ["link.md", "new.md"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses an escaping symlink and a broken symlink", () => {
        // Arrange
        const root = tree();
        const external = tree();
        try {
            writeFileSync(join(external, "secret.md"), "secret\n");
            symlinkSync(join(external, "secret.md"), join(root, "out.md"));
            symlinkSync("missing.md", join(root, "broken.md"));

            // Act
            const observed = inventory(root);

            // Assert
            assert.equal(observed.ok, false);
            assert.match(observed.ok ? "" : observed.problem, /symlink/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses a symlinked directory rather than walking it", () => {
        // Arrange
        const root = tree();
        const external = tree();
        try {
            writeFileSync(join(external, "secret.md"), "secret\n");
            symlinkSync(external, join(root, "docs"));

            // Act
            const observed = inventory(root);

            // Assert
            assert.equal(observed.ok, false);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses a FIFO with a controlled problem", () => {
        // Arrange
        const root = tree();
        try {
            assert.equal(spawnSync("mkfifo", [join(root, "pipe")]).status, 0);

            // Act
            const observed = inventory(root);

            // Assert
            assert.equal(observed.ok, false);
            assert.match(observed.ok ? "" : observed.problem, /not a regular file/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("leaves ordinary unchanged files and contained links unchanged", () => {
        // Arrange
        const root = tree();
        try {
            mkdirSync(join(root, "docs"));
            writeFileSync(join(root, "docs", "a.md"), "a\n");
            symlinkSync("a.md", join(root, "docs", "alias.md"));
            const before = entries(root);

            // Act
            const differences = inventoryDifferences(root, before);

            // Assert
            assert.deepEqual(differences, []);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
