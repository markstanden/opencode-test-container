import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    rmdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    preparedDifferences,
    prepareCampaign,
    loadPreparedManifest,
} from "../../src/campaign/prepare.ts";
import { inventory } from "../../src/campaign/inventory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");

/** Prepare a fixture whose skill gains an executable script and an empty dir. */
function prepared(): { dir: string; root: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-delivery-"));
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, "skills", "otel-helper", "run.sh"), "#!/bin/sh\n", {
        mode: 0o755,
    });
    mkdirSync(join(dir, "skills", "otel-helper", "empty"));
    const root = join(dir, "root");
    const result = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
    return { dir, root };
}

/** One version 1 inventory of a staged directory. */
function historicalInventory(path: string) {
    const observed = inventory(path);
    if (!observed.ok) throw new Error(observed.problem);
    return observed.entries;
}

/** The current prepared manifest, asserting readability. */
function manifestOf(root: string) {
    const loaded = loadPreparedManifest(root);
    if (!loaded.ok) throw new Error(loaded.problem);
    return loaded.manifest;
}

describe("frozen inventory execution identity", () => {
    it("declares version 2 and records the staged execute bit", () => {
        // Arrange
        const { dir, root } = prepared();
        try {
            // Act
            const manifest = manifestOf(root);

            // Assert
            assert.equal(manifest.inventoryVersion, 2);
            const staged = join(
                root,
                "prepare",
                "subjects",
                "skill-only",
                "skills",
                "otel-helper",
            );
            assert.equal(statSync(join(staged, "run.sh")).mode & 0o111, 0o111);
            assert.equal(statSync(join(staged, "empty")).isDirectory(), true);
            assert.deepEqual(preparedDifferences(root, manifest), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("detects a removed execute bit and a deleted empty directory", () => {
        // Arrange
        const { dir, root } = prepared();
        try {
            const manifest = manifestOf(root);
            const staged = join(
                root,
                "prepare",
                "subjects",
                "skill-only",
                "skills",
                "otel-helper",
            );
            chmodSync(join(staged, "run.sh"), 0o644);
            rmdirSync(join(staged, "empty"));

            // Act
            const differences = preparedDifferences(root, manifest);

            // Assert
            assert.equal(
                differences.some((entry) =>
                    /changed executable bit .*run\.sh/.test(entry),
                ),
                true,
                differences.join("; "),
            );
            assert.equal(
                differences.some((entry) => /missing .*empty/.test(entry)),
                true,
                differences.join("; "),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps a historical manifest on its original semantics", () => {
        // Arrange: an absent inventoryVersion is a version 1 manifest.
        const { dir, root } = prepared();
        try {
            const manifest = manifestOf(root);
            const historical = {
                ...manifest,
                subjects: manifest.subjects.map((arm) => ({
                    ...arm,
                    inventory: historicalInventory(
                        join(root, "prepare", "subjects", arm.armId),
                    ),
                })),
                cases: manifest.cases.map((testCase) => ({
                    ...testCase,
                    workspace: historicalInventory(
                        join(root, "prepare", "workspaces", testCase.caseId),
                    ),
                })),
            };
            delete historical.inventoryVersion;
            const staged = join(
                root,
                "prepare",
                "subjects",
                "skill-only",
                "skills",
                "otel-helper",
            );
            chmodSync(join(staged, "run.sh"), 0o600);
            mkdirSync(join(staged, "later-empty"));

            // Act
            const differences = preparedDifferences(root, historical);

            // Assert
            assert.deepEqual(differences, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
