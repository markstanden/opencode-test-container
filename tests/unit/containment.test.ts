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
    readContainedDocuments,
    readContainedFile,
} from "../../src/evidence/containment.ts";

/** A workspace with a regular document. */
function workspace(): string {
    return mkdtempSync(join(tmpdir(), "otc-contained-"));
}

describe("contained evidence reads", () => {
    it("reads an ordinary regular file", () => {
        // Arrange
        const root = workspace();
        try {
            mkdirSync(join(root, "docs"));
            writeFileSync(join(root, "docs", "ok.md"), "inside\n");

            // Act
            const read = readContainedFile(root, "docs/ok.md");

            // Assert
            assert.deepEqual(read, { ok: true, text: "inside\n" });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("refuses a file symlink that leaves the workspace", () => {
        // Arrange
        const root = workspace();
        const external = mkdtempSync(join(tmpdir(), "otc-external-"));
        try {
            mkdirSync(join(root, "docs"));
            writeFileSync(join(external, "secret.md"), "HOST_ONLY_SENTINEL\n");
            symlinkSync(
                join(external, "secret.md"),
                join(root, "docs", "linked.md"),
            );

            // Act
            const read = readContainedFile(root, "docs/linked.md");

            // Assert
            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.problem, /outside/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses a lake root that is a symlink to an external directory", () => {
        // Arrange
        const root = workspace();
        const external = mkdtempSync(join(tmpdir(), "otc-external-lake-"));
        try {
            writeFileSync(join(external, "review.md"), "HOST_ONLY_SENTINEL\n");
            symlinkSync(external, join(root, "docs"));

            // Act
            const read = readContainedDocuments(root, "docs", (name) =>
                name.endsWith(".md"),
            );

            // Assert
            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.problem, /symlink/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses a workspace root that is a symlink", () => {
        // Arrange
        const parent = workspace();
        const external = mkdtempSync(join(tmpdir(), "otc-external-workspace-"));
        try {
            writeFileSync(join(external, "secret.md"), "HOST_ONLY_SENTINEL\n");
            const linked = join(parent, "workspace");
            symlinkSync(external, linked);

            // Act
            const read = readContainedFile(linked, "secret.md");

            // Assert
            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.problem, /symlink/);
        } finally {
            rmSync(parent, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses an intermediate parent symlink", () => {
        // Arrange
        const root = workspace();
        const external = mkdtempSync(join(tmpdir(), "otc-external-parent-"));
        try {
            writeFileSync(join(external, "secret.md"), "HOST_ONLY_SENTINEL\n");
            symlinkSync(external, join(root, "docs"));

            // Act
            const read = readContainedFile(root, "docs/secret.md");

            // Assert
            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.problem, /outside/);
        } finally {
            rmSync(root, { recursive: true, force: true });
            rmSync(external, { recursive: true, force: true });
        }
    });

    it("refuses a dangling symlink and a directory where a file is required", () => {
        // Arrange
        const root = workspace();
        try {
            mkdirSync(join(root, "docs", "nested"), { recursive: true });
            symlinkSync("missing.md", join(root, "docs", "dangling.md"));
            writeFileSync(join(root, "docs", "nested", "file.md"), "x\n");

            // Act
            const dangling = readContainedFile(root, "docs/dangling.md");
            const directory = readContainedFile(root, "docs/nested");

            // Assert
            assert.equal(dangling.ok, false);
            assert.equal(directory.ok, false);
            assert.match(
                directory.ok ? "" : directory.problem,
                /not a regular file/,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("supports a contained relative symlink and reports its document", () => {
        // Arrange
        const root = workspace();
        try {
            mkdirSync(join(root, "docs"));
            writeFileSync(join(root, "docs", "real.md"), "contained\n");
            symlinkSync("real.md", join(root, "docs", "alias.md"));

            // Act
            const read = readContainedDocuments(root, "docs", (name) =>
                name.endsWith(".md"),
            );

            // Assert
            assert.equal(read.ok, true);
            const documents = read.ok ? read.documents : [];
            assert.deepEqual(documents.map((entry) => entry.path).sort(), [
                "docs/alias.md",
                "docs/real.md",
            ]);
            for (const document of documents) {
                assert.equal(document.contents, "contained\n");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not read or hang on a FIFO", () => {
        // Arrange
        const root = workspace();
        try {
            mkdirSync(join(root, "docs"));
            const fifo = join(root, "docs", "pipe.md");
            const made = spawnSync("mkfifo", [fifo]);
            assert.equal(made.status, 0);

            // Act
            const read = readContainedDocuments(root, "docs", (name) =>
                name.endsWith(".md"),
            );

            // Assert
            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.problem, /not a regular file/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("contained read race defence", () => {
    it(
        "refuses a final component swapped" + " to a symlink after resolution",
        () => {
            // Arrange
            const root = workspace();
            const external = mkdtempSync(join(tmpdir(), "otc-swap-"));
            try {
                mkdirSync(join(root, "docs"));
                writeFileSync(join(root, "docs", "target.md"), "inside\n");
                writeFileSync(
                    join(external, "secret.md"),
                    "HOST_ONLY_SENTINEL\n",
                );

                // Act
                const read = readContainedFile(root, "docs/target.md", {
                    beforeOpen: (realPath) => {
                        rmSync(realPath);
                        symlinkSync(join(external, "secret.md"), realPath);
                    },
                });

                // Assert
                assert.equal(
                    read.ok,
                    false,
                    "O_NOFOLLOW must refuse the swapped link",
                );
            } finally {
                rmSync(root, { recursive: true, force: true });
                rmSync(external, { recursive: true, force: true });
            }
        },
    );
});
