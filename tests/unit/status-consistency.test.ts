import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { statusOf } from "../../src/campaign/status.ts";
import { claimBudget, type BudgetClaim } from "../../src/campaign/budget.ts";
import type { CommandResult } from "../../src/adapters/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"f".repeat(64)}`;

/** A fake image resolver. */
const fakeImage = async (
    _command: string,
    args: readonly string[],
): Promise<CommandResult> => ({
    status: 0,
    signal: null,
    stdout: args.includes("inspect") ? `${IMAGE_ID}\n` : "opencode v2.2.6\n",
    stderr: "",
    timedOut: false,
    error: null,
});

/** A prepared and frozen skill campaign. */
async function campaignRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-status-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

/** A claim-like record for a reader that changes on a second call. */
function phantomClaim(): BudgetClaim {
    return {
        kind: "trial",
        index: 1,
        path: "/nonexistent/trial-0001.claim",
        state: "reserved",
        at: "2026-11-19T00:00:00.000Z",
        stamp: "s1",
        attemptId: null,
        note: "phantom",
        key: "slot:s1",
    };
}

describe("status observes one budget snapshot", () => {
    it("derives zero-used counts and actions from the same observation", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        let trialReads = 0;
        try {
            // Act: a second trial read would see one claim.
            const status = statusOf(root, {
                claims: (_root, kind) => {
                    if (kind !== "trial") return [];
                    trialReads += 1;
                    return trialReads > 1 ? [phantomClaim()] : [];
                },
            });

            // Assert
            assert.equal(trialReads, 1);
            assert.deepEqual(status.budgets, {
                trials: 3,
                used: 0,
                remaining: 3,
            });
            assert.equal(
                status.nextActions.some(
                    (action) =>
                        action.command.includes("otc run") &&
                        action.reason.includes("3 trial(s) budgeted"),
                ),
                true,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("derives one-used counts and actions from one changed observation", async () => {
        // Arrange
        const { dir, root } = await campaignRoot();
        const claim = claimBudget(join(root, "evidence"), "trial", 3, {
            stamp: "s1",
            key: "slot:s1",
            at: "2026-11-19T00:00:00.000Z",
        });
        assert.equal(claim.ok, true);
        if (!claim.ok) return;
        let trialReads = 0;
        try {
            // Act
            const status = statusOf(root, {
                claims: (_root, kind) => {
                    if (kind !== "trial") return [];
                    trialReads += 1;
                    return trialReads === 1 ? [claim.claim] : [];
                },
            });

            // Assert
            assert.equal(trialReads, 1);
            assert.deepEqual(status.budgets, {
                trials: 3,
                used: 1,
                remaining: 2,
            });
            assert.equal(
                status.nextActions.some((action) =>
                    action.reason.includes("2 trial(s) budgeted"),
                ),
                true,
            );
            const serialised = readFileSync(claim.claim.path, "utf8");
            assert.match(serialised, /"state": "reserved"/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
