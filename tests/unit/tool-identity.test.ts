import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    artifactSha256,
    toolIdentity,
    toolIdentityProblems,
} from "../../src/contracts/version.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

describe("executing tool identity", () => {
    it("changes when executable content changes under the same version", () => {
        // Arrange
        const copy = mkdtempSync(join(tmpdir(), "otc-tool-identity-"));
        try {
            cpSync(join(REPO, "package.json"), join(copy, "package.json"));
            cpSync(join(REPO, "src"), join(copy, "src"), {
                recursive: true,
            });
            const before = artifactSha256(copy);
            writeFileSync(
                join(copy, "src", "campaign", "judge.ts"),
                `${readFileSync(join(copy, "src", "campaign", "judge.ts"), "utf8")}\n// changed\n`,
                "utf8",
            );

            // Act
            const after = artifactSha256(copy);

            // Assert
            assert.notEqual(before, after);
        } finally {
            rmSync(copy, { recursive: true, force: true });
        }
    });

    it("uses the source tree when the executing module is under src", () => {
        // Arrange
        const copy = mkdtempSync(join(tmpdir(), "otc-tool-source-"));
        try {
            cpSync(join(REPO, "package.json"), join(copy, "package.json"));
            cpSync(join(REPO, "src"), join(copy, "src"), { recursive: true });
            cpSync(join(REPO, "dist"), join(copy, "dist"), { recursive: true });
            const moduleFile = join(copy, "src", "contracts", "version.ts");
            const before = artifactSha256(copy, moduleFile);
            writeFileSync(
                join(copy, "src", "campaign", "judge.ts"),
                `${readFileSync(join(copy, "src", "campaign", "judge.ts"), "utf8")}\n// changed\n`,
                "utf8",
            );

            // Act
            const after = artifactSha256(copy, moduleFile);

            // Assert
            assert.notEqual(before, after);
        } finally {
            rmSync(copy, { recursive: true, force: true });
        }
    });

    it("uses the built tree when the executing module is under dist", () => {
        // Arrange
        const copy = mkdtempSync(join(tmpdir(), "otc-tool-built-"));
        try {
            cpSync(join(REPO, "package.json"), join(copy, "package.json"));
            cpSync(join(REPO, "src"), join(copy, "src"), { recursive: true });
            cpSync(join(REPO, "dist"), join(copy, "dist"), { recursive: true });
            const moduleFile = join(copy, "dist", "contracts", "version.js");
            const before = artifactSha256(copy, moduleFile);
            writeFileSync(
                join(copy, "src", "campaign", "judge.ts"),
                `${readFileSync(join(copy, "src", "campaign", "judge.ts"), "utf8")}\n// source only\n`,
                "utf8",
            );
            const afterSource = artifactSha256(copy, moduleFile);
            writeFileSync(
                join(copy, "dist", "campaign", "judge.js"),
                `${readFileSync(join(copy, "dist", "campaign", "judge.js"), "utf8")}\n// built change\n`,
                "utf8",
            );

            // Act
            const afterBuilt = artifactSha256(copy, moduleFile);

            // Assert
            assert.equal(afterSource, before);
            assert.notEqual(afterBuilt, afterSource);
        } finally {
            rmSync(copy, { recursive: true, force: true });
        }
    });

    it("refuses a different version even when the content hash matches", () => {
        // Arrange
        const current = toolIdentity();
        const frozen = {
            ...current,
            version: "99.0.0",
        };

        // Act
        const problems = toolIdentityProblems(frozen, current);

        // Assert
        assert.equal(
            problems.some((problem) => /version/.test(problem)),
            true,
        );
    });

    it("refuses changed content under the same version", () => {
        // Arrange
        const current = toolIdentity();
        const frozen = {
            ...current,
            artifactSha256: "0".repeat(64),
        };

        // Act
        const problems = toolIdentityProblems(frozen, current);

        // Assert
        assert.equal(
            problems.some((problem) => /artifact/.test(problem)),
            true,
        );
    });

    it("accepts the executing identity that produced the freeze", () => {
        // Arrange
        const current = toolIdentity();

        // Act
        const problems = toolIdentityProblems(current, current);

        // Assert
        assert.deepEqual(problems, []);
    });
});
