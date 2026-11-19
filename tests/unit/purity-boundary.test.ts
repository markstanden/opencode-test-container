import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purityProblems } from "../support/purity.ts";

const HERE = import.meta.dirname;
const SRC = join(HERE, "..", "..", "src");

/** The explicit initial boundary. Extend only with a reviewed pure module. */
const PURE_MODULES = Object.freeze([
    join(SRC, "campaign", "eligibility.ts"),
    join(SRC, "campaign", "stop-policy.ts"),
    join(SRC, "campaign", "plan.ts"),
    join(SRC, "campaign", "primary-record.ts"),
    join(SRC, "reporting", "report-calculation.ts"),
]);

/** A disposable fixture tree with one module per entry. */
function fixture(files: Record<string, string>): {
    dir: string;
    file: (name: string) => string;
} {
    const dir = mkdtempSync(join(tmpdir(), "otc-purity-"));
    for (const [name, contents] of Object.entries(files)) {
        const path = join(dir, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, contents, "utf8");
    }
    return { dir, file: (name) => join(dir, name) };
}

describe("architecture purity boundary", () => {
    it("keeps the initial calculation modules free of ambient effects", () => {
        // Act
        const problems = purityProblems(PURE_MODULES.map((file) => ({ file })));

        // Assert
        assert.deepEqual(problems, []);
    });

    it("rejects direct clock and environment access", () => {
        // Arrange
        const space = fixture({
            "clock.ts": "export const t = new Date().toISOString();\n",
            "env.ts": "export const home = process.env.HOME;\n",
            "random.ts": "export const n = Math.random();\n",
        });
        try {
            // Act
            const problems = purityProblems([
                { file: space.file("clock.ts") },
                { file: space.file("env.ts") },
                { file: space.file("random.ts") },
            ]);

            // Assert
            assert.equal(
                problems.some((problem) => problem.includes("ambient clock")),
                true,
            );
            assert.equal(
                problems.some((problem) =>
                    problem.includes("ambient process state"),
                ),
                true,
            );
            assert.equal(
                problems.some((problem) => problem.includes("ambient random")),
                true,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("rejects an indirect I/O import through a wrapper and a barrel", () => {
        // Arrange
        const space = fixture({
            "entry.ts": 'export { read } from "./wrapper.ts";\n',
            "wrapper.ts": 'export { read } from "./io.ts";\n',
            "io.ts":
                'import { readFileSync } from "node:fs";\nexport const read = () => readFileSync("/tmp/x", "utf8");\n',
        });
        try {
            // Act
            const problems = purityProblems([{ file: space.file("entry.ts") }]);

            // Assert
            assert.equal(
                problems.some((problem) => problem.includes("node:fs")),
                true,
            );
            assert.equal(
                problems.some(
                    (problem) =>
                        problem.includes("chain") ||
                        problem.includes("entry.ts"),
                ),
                true,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("accepts a type-only import from an effectful module", () => {
        // Arrange
        const space = fixture({
            "entry.ts":
                'import type { Shape } from "./effectful.ts";\nexport const value: Shape = { n: 1 };\n',
            "effectful.ts":
                'import { readFileSync } from "node:fs";\nexport interface Shape { n: number }\nexport const read = () => readFileSync("/tmp/x", "utf8");\n',
        });
        try {
            // Act
            const problems = purityProblems([{ file: space.file("entry.ts") }]);

            // Assert
            assert.deepEqual(problems, []);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("accepts deterministic hashing and a privately owned accumulator", () => {
        // Arrange
        const space = fixture({
            "hash.ts":
                'import { createHash } from "node:crypto";\nexport function digest(values: readonly string[]): string {\n    const seen: string[] = [];\n    for (const value of values) seen.push(value);\n    const hash = createHash("sha256");\n    for (const value of seen) hash.update(value);\n    return hash.digest("hex");\n}\n',
        });
        try {
            // Act
            const problems = purityProblems([{ file: space.file("hash.ts") }]);

            // Assert
            assert.deepEqual(problems, []);
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });

    it("rejects dynamic loading that cannot be resolved", () => {
        // Arrange
        const space = fixture({
            "dynamic.ts":
                "export function load(name: string): Promise<unknown> {\n    return import(name);\n}\n",
            "literal.ts": 'export const load = () => import("node:fs");\n',
        });
        try {
            // Act
            const unresolved = purityProblems([
                { file: space.file("dynamic.ts") },
            ]);
            const literal = purityProblems([
                { file: space.file("literal.ts") },
            ]);

            // Assert
            assert.equal(
                unresolved.some((problem) =>
                    problem.includes("unresolvable dynamic import"),
                ),
                true,
            );
            assert.equal(
                literal.some((problem) => problem.includes("node:fs")),
                true,
            );
        } finally {
            rmSync(space.dir, { recursive: true, force: true });
        }
    });
});
