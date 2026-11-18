import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");

/** Copy the fixture into a disposable directory. */
function workspace(): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-overlap-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return { dir, campaignPath: join(dir, "campaign.json") };
}

describe("staging overlap and retriable preparation", () => {
    it("refuses a root inside a fixture before creating anything", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        try {
            const before = readFileSync(
                join(dir, "skills", "otel-helper", "SKILL.md"),
                "utf8",
            );
            const root = join(dir, "skills", "otel-helper", "run-root");

            // Act
            const prepared = prepareCampaign(campaignPath, root);

            // Assert
            assert.equal(prepared.ok, false);
            assert.match(
                prepared.ok ? "" : prepared.problems.join("; "),
                /inside staged input/,
            );
            assert.equal(existsSync(root), false);
            assert.equal(
                readFileSync(
                    join(dir, "skills", "otel-helper", "SKILL.md"),
                    "utf8",
                ),
                before,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("leaves a correctable invocation retriable at the same root", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        try {
            renameSync(
                join(dir, "skills", "otel-helper"),
                join(dir, "skills", "moved"),
            );
            const root = join(dir, "root");

            // Act: an ordinary staging error.
            const failed = prepareCampaign(campaignPath, root);

            // Assert: refused, and no provisional tree survives.
            assert.equal(failed.ok, false);
            assert.equal(existsSync(root), false);

            // Act: correction, same path.
            renameSync(
                join(dir, "skills", "moved"),
                join(dir, "skills", "otel-helper"),
            );
            const retried = prepareCampaign(campaignPath, root);

            // Assert
            assert.equal(
                retried.ok,
                true,
                retried.ok ? "" : retried.problems.join("; "),
            );
            assert.equal(
                existsSync(join(root, "prepare", "manifest.json")),
                true,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("never removes a pre-existing root", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        try {
            const root = join(dir, "root");
            mkdirSync(root);
            const sentinel = join(root, "someone-elses-work.txt");
            writeFileSync(sentinel, "keep me\n", "utf8");

            // Act
            const prepared = prepareCampaign(campaignPath, root);

            // Assert
            assert.equal(prepared.ok, false);
            assert.match(
                prepared.ok ? "" : prepared.problems.join("; "),
                /already exists/,
            );
            assert.equal(readFileSync(sentinel, "utf8"), "keep me\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("root creation", () => {
    it("creates a fresh nested path whose parents do not exist", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        try {
            const root = join(dir, "one", "two", "three", "run");

            // Act
            const prepared = prepareCampaign(campaignPath, root);

            // Assert
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            assert.equal(
                existsSync(join(root, "prepare", "manifest.json")),
                true,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lets exactly one of two competing prepares claim the root", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        try {
            const root = join(dir, "nested", "run");

            // Act
            const results = [
                prepareCampaign(campaignPath, root),
                prepareCampaign(campaignPath, root),
            ];

            // Assert
            assert.equal(results.filter((entry) => entry.ok).length, 1);
            assert.match(
                results.find((entry) => !entry.ok)?.ok === false
                    ? (results.find((entry) => !entry.ok) as {
                          problems: string[];
                      }).problems.join("; ")
                    : "",
                /already exists/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
