import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildImage, containerfileText } from "../../src/adapters/podman/image.ts";
import type { CommandResult } from "../../src/adapters/process.ts";

/** One accepted command result. */
const accepted: CommandResult = {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    error: null,
};

describe("packaged container recipe", () => {
    it("declares the Node base build argument before FROM", () => {
        // Arrange
        const recipe = containerfileText();
        const lines = recipe.split("\n");
        const argIndex = lines.findIndex(
            (line) => line.trim() === "ARG NODE_BASE",
        );
        const fromIndex = lines.findIndex((line) =>
            /^FROM\s+\$\{NODE_BASE\}$/.test(line.trim()),
        );

        // Act
        const ordered = argIndex !== -1 && fromIndex !== -1 && argIndex < fromIndex;

        // Assert
        assert.equal(
            ordered,
            true,
            "FROM ${NODE_BASE} needs a global ARG NODE_BASE declared before it",
        );
    });

    it("never floats the base image or the OpenCode version", () => {
        // Arrange
        const recipe = containerfileText();

        // Act
        const from = recipe
            .split("\n")
            .find((line) => line.startsWith("FROM "));

        // Assert
        assert.equal(from, "FROM ${NODE_BASE}");
        assert.match(recipe, /ARG OPENCODE_VERSION/);
        assert.match(recipe, /test -n "\$\{OPENCODE_VERSION\}"/);
    });

    it("passes both recipe inputs to the production build path", async () => {
        // Arrange
        const calls: { command: string; args: readonly string[] }[] = [];
        const run = async (command: string, args: readonly string[]) => {
            calls.push({ command, args });
            return accepted;
        };

        // Act
        await buildImage(
            {
                tag: "localhost/otc-recipe-test:1",
                nodeBase: "docker.io/library/node:26.13.0-slim",
                opencodeVersion: "2.2.6",
            },
            run,
        );

        // Assert
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.command, "podman");
        const args = calls[0]?.args ?? [];
        assert.ok(args.includes("NODE_BASE=docker.io/library/node:26.13.0-slim"));
        assert.ok(args.includes("OPENCODE_VERSION=2.2.6"));
        assert.match(args.at(-1) ?? "", /container$/);
    });
});
