import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "..", "src");

/** Every TypeScript source file under `src`. */
function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? sourceFiles(path)
            : entry.isFile() && entry.name.endsWith(".ts")
              ? [path]
              : [];
    });
}

describe("source boundary", () => {
    it("never names the docs repository's old placement harness", () => {
        // Arrange
        const files = sourceFiles(SOURCE);

        // Act
        const offenders = files.filter((path) =>
            /placement-harness|harness\.mts/.test(readFileSync(path, "utf8")),
        );

        // Assert
        assert.deepEqual(
            offenders.map((path) => relative(SOURCE, path)),
            [],
        );
    });

    it("keeps an emitted CLI that does not load a sibling checkout", () => {
        // Arrange
        const files = sourceFiles(SOURCE);

        // Act
        const offenders = files.filter((path) =>
            /opencode-docs-plugin|\.\.\/opencode-docs-plugin/.test(
                readFileSync(path, "utf8"),
            ),
        );

        // Assert
        assert.deepEqual(
            offenders.map((path) => relative(SOURCE, path)),
            [],
        );
    });
});
