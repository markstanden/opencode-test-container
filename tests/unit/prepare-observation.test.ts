import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes, sha256Of } from "../../src/contracts/canonical.ts";
import { loadCampaignBundle } from "../../src/contracts/validate.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");

/** Copy the fixture into a disposable directory. */
function workspace(): { dir: string; campaignPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-observe-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return { dir, campaignPath: join(dir, "campaign.json") };
}

/** A reader that returns one queued document per path, then the last value. */
function changingReader(initial: Map<string, Buffer>): {
    read: (path: string) => Buffer;
    counts: Map<string, number>;
} {
    const counts = new Map<string, number>();
    const queued = new Map(initial);
    return {
        counts,
        read: (path) => {
            counts.set(path, (counts.get(path) ?? 0) + 1);
            const value = queued.get(path);
            if (value === undefined) {
                throw new Error(`unexpected read of ${path}`);
            }
            return value;
        },
    };
}

describe("prepare observes each original document once", () => {
    it("reads the campaign and suite once each and binds the manifest to them", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        const suitePath = join(dir, "suite.json");
        const campaignBytes = readFileSync(campaignPath);
        const suiteBytes = readFileSync(suitePath);
        const changed = changingReader(
            new Map([
                [campaignPath, campaignBytes],
                [suitePath, suiteBytes],
            ]),
        );
        try {
            // Act
            const prepared = prepareCampaign(campaignPath, join(dir, "root"), {
                readDocument: changed.read,
            });

            // Assert
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            assert.equal(changed.counts.get(campaignPath), 1);
            assert.equal(changed.counts.get(suitePath), 1);
            if (!prepared.ok) return;
            assert.equal(
                prepared.manifest.campaignSha256,
                sha256Bytes(campaignBytes),
            );
            assert.equal(
                prepared.manifest.suiteSha256,
                sha256Bytes(suiteBytes),
            );
            assert.equal(
                readFileSync(
                    join(dir, "root", "prepare", "campaign.json"),
                    "utf8",
                ),
                campaignBytes.toString("utf8"),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts a declared raw suite digest", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        const suiteBytes = readFileSync(join(dir, "suite.json"));
        const declared = JSON.parse(readFileSync(campaignPath, "utf8")) as {
            suite: { path: string; sha256?: string };
        };
        declared.suite.sha256 = sha256Bytes(suiteBytes);
        writeFileSync(campaignPath, `${JSON.stringify(declared, null, 2)}\n`);
        try {
            // Act
            const accepted = prepareCampaign(campaignPath, join(dir, "root"));

            // Assert
            assert.equal(
                accepted.ok,
                true,
                accepted.ok ? "" : accepted.problems.join("; "),
            );
            if (!accepted.ok) return;
            assert.equal(
                accepted.manifest.suiteSha256,
                sha256Bytes(suiteBytes),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a declared suite digest that does not name the observed bytes", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        const declared = JSON.parse(readFileSync(campaignPath, "utf8")) as {
            suite: { path: string; sha256?: string };
        };
        declared.suite.sha256 = "0".repeat(64);
        writeFileSync(campaignPath, `${JSON.stringify(declared, null, 2)}\n`);
        const refusedRoot = join(dir, "refused");
        try {
            // Act
            const refused = prepareCampaign(campaignPath, refusedRoot);

            // Assert: refusal happens before the root is created.
            assert.equal(refused.ok, false);
            assert.match(
                refused.ok ? "" : refused.problems.join("; "),
                /suite sha256 mismatch/,
            );
            assert.equal(existsSync(refusedRoot), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("keeps the raw suite digest distinct from its canonical digest", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        const plain = loadCampaignBundle(campaignPath);
        assert.equal(plain.ok, true);
        if (!plain.ok) return;
        const suitePath = join(dir, "suite.json");
        writeFileSync(suitePath, `${readFileSync(suitePath, "utf8")}\n`);
        try {
            // Act
            const spaced = loadCampaignBundle(campaignPath);

            // Assert
            assert.equal(spaced.ok, true);
            if (!spaced.ok) return;
            assert.notEqual(spaced.value.suiteSha256, plain.value.suiteSha256);
            assert.equal(
                sha256Of(spaced.value.suite),
                sha256Of(plain.value.suite),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("cannot mix two source versions in the staged values and receipt", () => {
        // Arrange
        const { dir, campaignPath } = workspace();
        const suitePath = join(dir, "suite.json");
        const campaignA = JSON.parse(readFileSync(campaignPath, "utf8")) as {
            campaignId: string;
        };
        const campaignB = { ...campaignA, campaignId: "skill-basic-other" };
        const suiteA = JSON.parse(readFileSync(suitePath, "utf8")) as {
            suiteId: string;
        };
        const suiteB = { ...suiteA, suiteId: "skill-basic-other" };
        const bytesA = Buffer.from(`${JSON.stringify(campaignA, null, 2)}\n`);
        const bytesB = Buffer.from(`${JSON.stringify(campaignB, null, 2)}\n`);
        const suiteBytesA = Buffer.from(`${JSON.stringify(suiteA, null, 2)}\n`);
        const suiteBytesB = Buffer.from(`${JSON.stringify(suiteB, null, 2)}\n`);
        let campaignReads = 0;
        let suiteReads = 0;
        const read = (path: string): Buffer => {
            if (path === campaignPath) {
                campaignReads += 1;
                return campaignReads === 1 ? bytesA : bytesB;
            }
            if (path === suitePath) {
                suiteReads += 1;
                return suiteReads === 1 ? suiteBytesA : suiteBytesB;
            }
            throw new Error(`unexpected read of ${path}`);
        };
        try {
            // Act
            const prepared = prepareCampaign(campaignPath, join(dir, "root"), {
                readDocument: read,
            });

            // Assert: the first observation is the only one used.
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            assert.equal(campaignReads, 1);
            assert.equal(suiteReads, 1);
            if (!prepared.ok) return;
            assert.equal(prepared.manifest.campaignId, "skill-basic-local");
            assert.equal(prepared.manifest.suiteId, "skill-basic");
            assert.equal(prepared.manifest.campaignSha256, sha256Bytes(bytesA));
            assert.equal(
                prepared.manifest.suiteSha256,
                sha256Bytes(suiteBytesA),
            );
            assert.equal(
                readFileSync(
                    join(dir, "root", "prepare", "campaign.json"),
                    "utf8",
                ),
                bytesA.toString("utf8"),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
