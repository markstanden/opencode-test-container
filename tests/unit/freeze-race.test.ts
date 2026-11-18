import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import {
    freezeCampaign,
    frozenPath,
    loadFrozen,
} from "../../src/campaign/freeze.ts";
import type { CommandResult } from "../../src/adapters/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");

/** A result with the given stdout. */
function ok(stdout: string): CommandResult {
    return {
        status: 0,
        signal: null,
        stdout,
        stderr: "",
        timedOut: false,
        error: null,
    };
}

/** A prepared root for the race. */
function preparedRoot(): { dir: string; root: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-freeze-race-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    return { dir, root };
}

/**
 * A process adapter that holds every inspection until both callers have
 * arrived, then answers with the image id that caller's inspection index
 * selects. This forces the overlap deterministically.
 */
function racingImages(ids: readonly string[]) {
    let inspections = 0;
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
        release = resolve;
    });
    const run = async (
        _command: string,
        args: readonly string[],
    ): Promise<CommandResult> => {
        if (args.includes("inspect")) {
            const index = inspections;
            inspections += 1;
            if (inspections === 2) release();
            await bothArrived;
            return ok(`${ids[index] ?? ids[0]}\n`);
        }
        return ok("opencode v2.2.6\n");
    };
    return { run, arrivals: () => inspections };
}

describe("freeze receipt publication", () => {
    it("lets exactly one of two conflicting resolved images succeed", async () => {
        // Arrange
        const { dir, root } = preparedRoot();
        const first = `sha256:${"a".repeat(64)}`;
        const second = `sha256:${"b".repeat(64)}`;
        const images = racingImages([first, second]);
        try {
            // Act
            const results = await Promise.all([
                freezeCampaign(root, images.run as never),
                freezeCampaign(root, images.run as never),
            ]);

            // Assert
            assert.equal(images.arrivals(), 2);
            assert.equal(results.filter((entry) => entry.ok).length, 1);
            const refused = results.find((entry) => !entry.ok);
            assert.equal(refused?.ok, false);
            assert.match(
                refused?.ok === false ? refused.problems.join("; ") : "",
                /another freeze already published a different receipt/,
            );
            const durable = loadFrozen(root);
            assert.equal(durable.ok, true);
            const winner = results.find((entry) => entry.ok);
            assert.equal(
                durable.ok ? durable.record.imageId : "",
                winner?.ok === true ? winner.record.imageId : "",
            );
            assert.equal(
                readdirSync(join(root, "prepare")).filter((name) =>
                    name.includes("frozen.json.tmp-"),
                ).length,
                0,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("converges same-identity callers on the durable receipt", async () => {
        // Arrange
        const { dir, root } = preparedRoot();
        const image = `sha256:${"c".repeat(64)}`;
        const images = racingImages([image, image]);
        try {
            // Act
            const results = await Promise.all([
                freezeCampaign(root, images.run as never),
                freezeCampaign(root, images.run as never),
            ]);

            // Assert
            assert.equal(results.filter((entry) => entry.ok).length, 2);
            const hashes = new Set(
                results.flatMap((entry) =>
                    entry.ok ? [entry.record.freezeSha256] : [],
                ),
            );
            assert.equal(hashes.size, 1);
            assert.equal(
                results.filter((entry) => entry.ok && !entry.alreadyFrozen)
                    .length,
                1,
            );
            const durable = loadFrozen(root);
            assert.equal(durable.ok, true);
            assert.equal(
                readFileSync(frozenPath(root), "utf8"),
                `${JSON.stringify(
                    durable.ok ? durable.record : {},
                    null,
                    2,
                )}\n`,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
