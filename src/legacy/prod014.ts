/**
 * Explicit readers for the frozen prod014 layout.
 *
 * Historical scenario ids, stamps, pair ids and frozen schedule bytes are
 * records, not templates. These adapters translate the old fields into the
 * new vocabulary without renaming an id or rewriting the source file. A
 * legacy campaign is never resumed by the new engine: the reader exists for
 * comparison and provenance, and new work gets a fresh OTC root.
 */

import type { Slot } from "../contracts/types.ts";
import { isRecord } from "../contracts/validate.ts";

/** One translated legacy slot, retaining every historical identity. */
export interface LegacySlot {
    /** The new slot identity: the frozen stamp, unchanged. */
    slot: Slot;
    /** The historical numeric slot position. */
    legacySlot: number;
    /** The frozen pair identity. */
    pairId: string;
    /** The historical scenario id, unchanged. */
    legacyScenario: string;
    /** The historical stamp, unchanged. */
    legacyStamp: string;
    /** The historical arm label, unchanged. */
    legacyArm: string;
}

/** A translated legacy schedule. */
export interface LegacySchedule {
    /** The kind value. */
    kind: "prod014-schedule";
    /** The legacy campaign id value. */
    legacyCampaignId: string;
    /** The generator value. */
    generator: string | null;
    /** The slots value. */
    slots: LegacySlot[];
}

/** A parsed legacy record, or every reason it is unusable. */
export type LegacyParse<T> =
    { ok: true; value: T } | { ok: false; problems: string[] };

/** A required non-blank string field. */
function requiredLegacyText(
    value: unknown,
    field: string,
    where: string,
    problems: string[],
): string | undefined {
    if (typeof value === "string" && value !== "") return value;
    problems.push(`${where}.${field} is missing`);
    return undefined;
}

/** A required integer field with a floor. */
function requiredLegacyInteger(
    value: unknown,
    field: string,
    floor: number,
    where: string,
    problems: string[],
): number | undefined {
    if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= floor
    ) {
        return value;
    }
    problems.push(`${where}.${field} must be an integer >= ${floor}`);
    return undefined;
}

/** Translate one frozen schedule slot. */
function legacySlotOf(
    entry: unknown,
    index: number,
): { ok: true; slot: LegacySlot } | { ok: false; problems: string[] } {
    const where = `legacy schedule slot[${index}]`;
    if (!isRecord(entry)) {
        return { ok: false, problems: [`${where} is not an object`] };
    }
    const problems: string[] = [];
    const slot = requiredLegacyInteger(entry.slot, "slot", 1, where, problems);
    const repetition = requiredLegacyInteger(
        entry.repetition,
        "repetition",
        0,
        where,
        problems,
    );
    const pairId = requiredLegacyText(entry.pairId, "pairId", where, problems);
    const scenario = requiredLegacyText(
        entry.scenario,
        "scenario",
        where,
        problems,
    );
    const arm = requiredLegacyText(entry.arm, "arm", where, problems);
    const stamp = requiredLegacyText(entry.stamp, "stamp", where, problems);
    if (
        problems.length > 0 ||
        slot === undefined ||
        repetition === undefined ||
        pairId === undefined ||
        scenario === undefined ||
        arm === undefined ||
        stamp === undefined
    ) {
        return { ok: false, problems };
    }
    return {
        ok: true,
        slot: {
            slot: {
                slotId: stamp,
                caseId: scenario,
                armId: arm,
                repetitionId: `r${repetition}`,
            },
            legacySlot: slot,
            pairId,
            legacyScenario: scenario,
            legacyStamp: stamp,
            legacyArm: arm,
        },
    };
}

/** Translate slots, refusing a duplicate historical stamp. */
function uniqueLegacySlots(value: readonly unknown[]): {
    slots: LegacySlot[];
    problems: string[];
} {
    const slots: LegacySlot[] = [];
    const problems: string[] = [];
    const stamps = new Set<string>();
    for (const [index, entry] of value.entries()) {
        const parsed = legacySlotOf(entry, index);
        if (!parsed.ok) {
            problems.push(...parsed.problems);
            continue;
        }
        if (stamps.has(parsed.slot.legacyStamp)) {
            problems.push(
                `legacy schedule slot[${index}].stamp duplicates ${parsed.slot.legacyStamp}`,
            );
            continue;
        }
        stamps.add(parsed.slot.legacyStamp);
        slots.push(parsed.slot);
    }
    return { slots, problems };
}

/**
 * Translate one frozen prod014 `schedule.json` value.
 * @param value The parsed JSON value.
 * @returns The translated schedule, or explicit problems.
 */
export function readLegacySchedule(
    value: unknown,
): LegacyParse<LegacySchedule> {
    if (!isRecord(value)) {
        return { ok: false, problems: ["legacy schedule must be an object"] };
    }
    if (typeof value.campaign !== "string" || value.campaign === "") {
        return { ok: false, problems: ["legacy schedule has no campaign id"] };
    }
    if (!Array.isArray(value.slots) || value.slots.length === 0) {
        return { ok: false, problems: ["legacy schedule has no slots"] };
    }
    const { slots, problems } = uniqueLegacySlots(value.slots);
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        value: {
            kind: "prod014-schedule",
            legacyCampaignId: value.campaign,
            generator:
                typeof value.generator === "string" ? value.generator : null,
            slots,
        },
    };
}

/** One translated legacy manifest arm. */
export interface LegacyArm {
    /** The arm id value. */
    armId: string;
    /** The label value. */
    label: string;
}

/** One translated legacy manifest scenario. */
export interface LegacyScenario {
    /** The case id value. */
    caseId: string;
    /** The kind value. */
    kind: string;
    /** The old mutation/preservation blocks are preserved verbatim. */
    legacy: Record<string, unknown>;
}

/** A translated legacy campaign manifest. */
export interface LegacyManifest {
    /** The kind value. */
    kind: "prod014-manifest";
    /** The legacy campaign id value. */
    legacyCampaignId: string;
    /** The question value. */
    question: string | null;
    /** The arms value. */
    arms: LegacyArm[];
    /** The scenarios value. */
    scenarios: LegacyScenario[];
}

/** Translate the manifest's arms. */
function legacyArmsOf(value: unknown): LegacyParse<LegacyArm[]> {
    if (value === undefined) return { ok: true, value: [] };
    if (!Array.isArray(value)) {
        return {
            ok: false,
            problems: ["legacy manifest arms must be an array"],
        };
    }
    const arms: LegacyArm[] = [];
    for (const [index, entry] of value.entries()) {
        if (!isRecord(entry) || typeof entry.id !== "string") {
            return {
                ok: false,
                problems: [`legacy manifest arm[${index}] is malformed`],
            };
        }
        arms.push({
            armId: entry.id,
            label: typeof entry.label === "string" ? entry.label : "",
        });
    }
    return { ok: true, value: arms };
}

/** Translate the manifest's scenarios, preserving unknown blocks. */
function legacyScenariosOf(value: unknown): LegacyParse<LegacyScenario[]> {
    if (value === undefined) return { ok: true, value: [] };
    if (!Array.isArray(value)) {
        return {
            ok: false,
            problems: ["legacy manifest scenarios must be an array"],
        };
    }
    const scenarios: LegacyScenario[] = [];
    for (const [index, entry] of value.entries()) {
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.kind !== "string"
        ) {
            return {
                ok: false,
                problems: [`legacy manifest scenario[${index}] is malformed`],
            };
        }
        const { id, kind, ...legacy } = entry;
        scenarios.push({ caseId: id, kind, legacy });
    }
    return { ok: true, value: scenarios };
}

/**
 * Translate one frozen prod014 `manifest.json` value. Unknown fields remain
 * in `legacy` so an old fact is never silently discarded.
 * @param value The parsed JSON value.
 * @returns The translated manifest, or explicit problems.
 */
export function readLegacyManifest(
    value: unknown,
): LegacyParse<LegacyManifest> {
    if (!isRecord(value)) {
        return { ok: false, problems: ["legacy manifest must be an object"] };
    }
    if (value.schemaVersion !== 1) {
        return {
            ok: false,
            problems: ["legacy manifest schemaVersion must be 1"],
        };
    }
    if (!isRecord(value.campaign)) {
        return {
            ok: false,
            problems: ["legacy manifest has no campaign block"],
        };
    }
    const campaignId = value.campaign.id;
    if (typeof campaignId !== "string" || campaignId === "") {
        return { ok: false, problems: ["legacy manifest has no campaign id"] };
    }
    const arms = legacyArmsOf(value.arms);
    if (!arms.ok) return arms;
    const scenarios = legacyScenariosOf(value.scenarios);
    if (!scenarios.ok) return scenarios;
    return {
        ok: true,
        value: {
            kind: "prod014-manifest",
            legacyCampaignId: campaignId,
            question:
                typeof value.campaign.question === "string"
                    ? value.campaign.question
                    : null,
            arms: arms.value,
            scenarios: scenarios.value,
        },
    };
}
