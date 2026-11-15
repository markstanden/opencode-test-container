import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    readLegacyManifest,
    readLegacySchedule,
} from "../../src/legacy/prod014.ts";

describe("prod014 schedule adapter", () => {
    it("keeps stamps and scenario ids while mapping new field names", () => {
        const parsed = readLegacySchedule({
            campaign: "pd-20261111",
            generator: "declared pair order",
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "A",
                    stamp: "pd-A-r0-R01",
                },
                {
                    slot: 2,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "B",
                    stamp: "pd-B-r0-R01",
                },
            ],
        });
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.value.legacyCampaignId, "pd-20261111");
        assert.equal(parsed.value.slots[0]?.slot.slotId, "pd-A-r0-R01");
        assert.equal(parsed.value.slots[0]?.legacyScenario, "R01");
        assert.equal(parsed.value.slots[0]?.slot.caseId, "R01");
        assert.equal(parsed.value.slots[0]?.slot.repetitionId, "r0");
    });

    it("refuses a duplicate stamp instead of renaming it", () => {
        const parsed = readLegacySchedule({
            campaign: "c",
            slots: [
                {
                    slot: 1,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "A",
                    stamp: "same",
                },
                {
                    slot: 2,
                    pairId: "P01",
                    repetition: 0,
                    scenario: "R01",
                    arm: "B",
                    stamp: "same",
                },
            ],
        });
        assert.equal(parsed.ok, false);
    });
});

describe("prod014 manifest adapter", () => {
    it("preserves scenario-specific blocks verbatim", () => {
        const block = {
            id: "R02",
            kind: "update",
            mutationPolicy: { allowed: ["work/src/**"] },
        };
        const parsed = readLegacyManifest({
            schemaVersion: 1,
            campaign: { id: "pd-fresh", question: "q" },
            arms: [{ id: "A", label: "native" }],
            scenarios: [block],
        });
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.deepEqual(parsed.value.scenarios[0]?.legacy, {
            mutationPolicy: { allowed: ["work/src/**"] },
        });
    });

    it("refuses an unknown schema version", () => {
        const parsed = readLegacyManifest({ schemaVersion: 2 });
        assert.equal(parsed.ok, false);
    });
});
