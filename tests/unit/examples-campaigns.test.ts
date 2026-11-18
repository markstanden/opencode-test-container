import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadCampaignBundle } from "../../src/contracts/validate.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Every campaign document shipped under examples/. */
function exampleCampaigns(): string[] {
    const examples = join(repoRoot, "examples");
    return readdirSync(examples, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === "campaign.json")
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

describe("shipped example campaigns", () => {
    it("finds at least one campaign to validate", () => {
        assert.ok(exampleCampaigns().length > 0);
    });

    for (const campaignPath of exampleCampaigns()) {
        it(`${relative(repoRoot, campaignPath)} validates with its suite`, () => {
            const loaded = loadCampaignBundle(campaignPath);

            assert.deepEqual(
                loaded.ok ? [] : loaded.problems,
                [],
                `${relative(repoRoot, campaignPath)} does not validate`,
            );
        });
    }
});
