import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLegacySchedule } from "../../src/legacy/prod014.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "prod014", "schedule.json");

describe("frozen prod014 schedule replay", () => {
    it("maps every historical stamp without renaming scenario or arm", () => {
        // Arrange
        const value: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
        // Act
        const parsed = readLegacySchedule(value);
        // Assert
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.value.legacyCampaignId, "pd-20261111");
        assert.equal(parsed.value.slots.length, 16);
        const pairs = new Set(parsed.value.slots.map((slot) => slot.pairId));
        assert.equal(pairs.size, 8);
        assert.deepEqual(
            parsed.value.slots.map((slot) => slot.slot.slotId),
            parsed.value.slots.map((slot) => slot.legacyStamp),
        );
        assert.equal(
            parsed.value.slots.filter((slot) => slot.slot.armId === "A").length,
            8,
        );
        assert.equal(
            parsed.value.slots.filter((slot) => slot.slot.armId === "B").length,
            8,
        );
        assert.deepEqual(
            parsed.value.slots
                .slice(0, 2)
                .map((slot) => slot.slot.repetitionId),
            ["r0", "r0"],
        );
    });
});
