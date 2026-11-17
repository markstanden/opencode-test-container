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
import { loadPreparedManifest } from "../../src/campaign/prepare.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import { sha256Of } from "../../src/contracts/canonical.ts";
import { checkedAssessments } from "../../src/evidence/assessments.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "assessment-v0.1.1", "root");

/** Copy the genuine v0.1.1 root to a disposable directory. */
function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "otc-old-assessment-"));
    cpSync(FIXTURE, dir, { recursive: true });
    return dir;
}

/** Read the fixture's one checked record. */
function checked(dir: string) {
    const prepared = loadPreparedManifest(dir);
    if (!prepared.ok) throw new Error(prepared.problem);
    const checkedSet = checkedAssessments({
        root: dir,
        manifest: prepared.manifest,
        ledger: readLedger(dir),
    });
    return { manifest: prepared.manifest, checkedSet };
}

describe("genuine v0.1.1 assessment reader", () => {
    it("reads the old format as valid and historical", () => {
        // Arrange
        const dir = root();
        try {
            // Act
            const { checkedSet } = checked(dir);
            const entry = checkedSet.records[0];

            // Assert
            assert.equal(entry?.state, "valid", checkedSet.problems.join("; "));
            assert.equal(entry?.historical, true);
            assert.equal(entry?.record?.evaluatorVersion, undefined);
            assert.equal(entry?.record?.evidence, undefined);
            assert.match(
                entry?.limitations.join("; ") ?? "",
                /no source-evidence binding/,
            );
            // The fixture's ledger hash binds the exact old bytes.
            assert.equal(
                readLedger(dir).events.find(
                    (event) => event.event === "assessment",
                )?.assessmentSha256,
                sha256Of(entry?.record),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("still detects tampering through the old ledger hash", () => {
        // Arrange
        const dir = root();
        try {
            const path = join(dir, "evidence", "assessments", "s1.json");
            const value = JSON.parse(readFileSync(path, "utf8")) as Record<
                string,
                unknown
            >;
            value.outcome = "pass";

            // Act
            writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
            const { checkedSet } = checked(dir);

            // Assert
            assert.equal(checkedSet.records[0]?.state, "conflicting");
            assert.match(
                checkedSet.problems.join("; "),
                /does not match its ledger hash/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("does not invent a source binding the old format never had", () => {
        // Arrange
        const dir = root();
        try {
            // Act: deleting evidence the old reader never bound must not be
            // reported as a conflict; the limitation is explicit instead.
            rmSync(join(dir, "evidence", "trials", "s1", "events.jsonl"));
            const { checkedSet } = checked(dir);

            // Assert
            assert.equal(checkedSet.records[0]?.state, "valid");
            assert.equal(checkedSet.records[0]?.historical, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
