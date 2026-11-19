import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    advanceClaim,
    claimBudget,
    readClaims,
    releaseClaim,
} from "../../src/campaign/budget.ts";

/** Run a body with a clock that advances on every sample. */
function withAdvancingClock<T>(body: () => T): T {
    const realDate = globalThis.Date;
    let tick = 0;
    class AdvancingDate extends realDate {
        constructor(value?: string | number | Date) {
            if (arguments.length === 0) {
                super(realDate.UTC(2026, 10, 19, 0, 0, tick));
                tick += 1;
                return;
            }
            super(value as string);
        }
    }
    globalThis.Date = AdvancingDate as unknown as DateConstructor;
    try {
        return body();
    } finally {
        globalThis.Date = realDate;
    }
}

/** A disposable evidence root. */
function workspace(): { dir: string; root: string } {
    const dir = mkdtempSync(join(tmpdir(), "otc-claim-"));
    return { dir, root: dir };
}

/** The claim record currently persisted at a path. */
function persisted(path: string): {
    at: string;
    state: string;
    key: string | null;
} {
    return JSON.parse(readFileSync(path, "utf8")) as {
        at: string;
        state: string;
        key: string | null;
    };
}

describe("claim receipt ownership", () => {
    it("returns the same timestamp it persists when the clock advances", () => {
        // Arrange
        const { dir, root } = workspace();
        try {
            // Act
            const claim = withAdvancingClock(() =>
                claimBudget(root, "trial", 1, {
                    stamp: "s1",
                    key: "slot:s1",
                }),
            );

            // Assert
            assert.equal(claim.ok, true);
            if (!claim.ok) return;
            assert.match(claim.claim.at ?? "", /^2026-11-19T00:00:00.000Z$/);
            assert.equal(persisted(claim.claim.path).at, claim.claim.at);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("round-trips an explicitly supplied timestamp", () => {
        // Arrange
        const { dir, root } = workspace();
        const at = "2026-01-02T03:04:05.006Z";
        try {
            // Act
            const claim = claimBudget(root, "judge", 1, { at });

            // Assert
            assert.equal(claim.ok, true);
            if (!claim.ok) return;
            assert.equal(claim.claim.at, at);
            assert.equal(persisted(claim.claim.path).at, at);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses to remove a claim a retained handle has already advanced", () => {
        // Arrange
        const { dir, root } = workspace();
        try {
            const claimed = claimBudget(root, "trial", 1, {
                stamp: "s1",
                key: "slot:s1",
                at: "2026-01-01T00:00:00.000Z",
            });
            assert.equal(claimed.ok, true);
            if (!claimed.ok) return;
            advanceClaim(claimed.claim, "spawned", {
                note: "dispatch started",
            });

            // Act
            const refunded = releaseClaim(claimed.claim);

            // Assert
            assert.equal(refunded, false);
            assert.equal(existsSync(claimed.claim.path), true);
            assert.equal(persisted(claimed.claim.path).state, "spawned");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("cannot release a newer owner's reservation at a reused index", () => {
        // Arrange
        const { dir, root } = workspace();
        try {
            const first = claimBudget(root, "trial", 2, {
                stamp: "s1",
                key: "slot:s1",
                at: "2026-01-01T00:00:00.000Z",
            });
            assert.equal(first.ok, true);
            if (!first.ok) return;
            assert.equal(releaseClaim(first.claim), true);
            const second = claimBudget(root, "trial", 2, {
                stamp: "s2",
                key: "slot:s2",
                at: "2026-01-02T00:00:00.000Z",
            });
            assert.equal(second.ok, true);
            if (!second.ok) return;
            assert.equal(second.claim.index, first.claim.index);

            // Act
            const staleReleased = releaseClaim(first.claim);

            // Assert
            assert.equal(staleReleased, false);
            assert.equal(existsSync(second.claim.path), true);
            assert.equal(persisted(second.claim.path).key, "slot:s2");
            assert.deepEqual(
                readClaims(root, "trial").map((claim) => claim.key),
                ["slot:s2"],
            );
            assert.equal(releaseClaim(second.claim), true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("lets the current owner release an unspent claim and retry the same key", () => {
        // Arrange
        const { dir, root } = workspace();
        try {
            const first = claimBudget(root, "judge", 1, {
                stamp: "s1",
                key: "s1/attempt-001",
                at: "2026-01-01T00:00:00.000Z",
            });
            assert.equal(first.ok, true);
            if (!first.ok) return;

            // Act
            const released = releaseClaim(first.claim);
            const retried = claimBudget(root, "judge", 1, {
                stamp: "s1",
                key: "s1/attempt-001",
                at: "2026-01-01T00:00:01.000Z",
            });

            // Assert
            assert.equal(released, true);
            assert.equal(retried.ok, true);
            assert.deepEqual(readClaims(root, "judge").length, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
