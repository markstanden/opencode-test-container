import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
    linkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256Of } from "../contracts/canonical.ts";
import { isRecord } from "../contracts/validate.ts";
import { loadPreparedManifest, type PreparedManifest } from "./prepare.ts";
import { deliveryCheck, loadFrozen } from "./freeze.ts";
import {
    appendLedgerEvent,
    readLedger,
    type LedgerEvent,
    type LedgerRead,
} from "./ledger.ts";
import { trialDirectory } from "./run.ts";
import type { Slot } from "../contracts/types.ts";
import { assessSkillTrial } from "../evaluators/skills/assess.ts";
import { assessDocsTrial } from "../evaluators/docs/assess.ts";
import {
    assessmentRecordPath,
    checkedAssessments,
} from "../evidence/assessments.ts";
import { assessShouldStop } from "./stop-policy.ts";
import { withAdmission } from "./admission.ts";
import { readClaims } from "./budget.ts";
import { compareCodeUnits } from "../contracts/ordering.ts";

/** One stored assessment. */
export type StoredAssessment =
    ReturnType<typeof assessSkillTrial> | ReturnType<typeof assessDocsTrial>;

/** Aggregate counts for a status/report line. */
export interface AssessmentSummary {
    /** The assessed value. */
    assessed: number;
    /** The pass value. */
    pass: number;
    /** The fail value. */
    fail: number;
    /** The unknown value. */
    unknown: number;
    /** The invalid value. */
    invalid: number;
    /** The unrun value. */
    unrun: number;
}

/** The result of one assess invocation. */
export interface AssessResult {
    /** The ok value. */
    ok: boolean;
    /** The summary value. */
    summary: AssessmentSummary;
    /** The problems value. */
    problems: string[];
    /** Slots deliberately left unassessed, with the reason. */
    skipped: string[];
    /** The slot the stop policy stopped after, or null. */
    stoppedAt: string | null;
}

/** An empty aggregate. */
function emptySummary(): AssessmentSummary {
    return { assessed: 0, pass: 0, fail: 0, unknown: 0, invalid: 0, unrun: 0 };
}

/** Path of one deterministic assessment. */
export function assessmentPath(root: string, slotId: string): string {
    return assessmentRecordPath(root, slotId);
}

/** The semantic identity of an assessment: everything but its creation time. */
export function assessmentIdentity(assessment: StoredAssessment): string {
    const semantic: Record<string, unknown> = { ...assessment };
    delete semantic.assessedAt;
    return canonicalJson(semantic);
}

/** Why assessment is refused now, or null when it may proceed. */
function assessmentRefusal(root: string, ledger: LedgerRead): string | null {
    const frozen = loadFrozen(root);
    if (!frozen.ok) return frozen.problem;
    if (ledger.state === "malformed") {
        return `attempt ledger is malformed: ${ledger.problems.join("; ")}`;
    }
    return null;
}

/** Build the deterministic assessment for one slot. */
function assessmentForSlot(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
    now: () => string,
): StoredAssessment | null {
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (testCase === undefined) return null;
    const trialDir = trialDirectory(root, slot.slotId);
    const common = {
        campaignId: manifest.campaignId,
        slotId: slot.slotId,
        caseId: slot.caseId,
        armId: slot.armId,
        repetitionId: slot.repetitionId,
        attemptId: `deterministic-${slot.slotId}`,
        assessedAt: now(),
    };
    if (testCase.kind === "skill-trigger") {
        return assessSkillTrial({ ...common, testCase, trialDir });
    }
    const preparedCase = manifest.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    return assessDocsTrial({
        ...common,
        testCase,
        trialDir,
        workspace: join(trialDir, "workspace"),
        prepared: new Map(
            (preparedCase?.workspace ?? []).map((entry) => [
                entry.path,
                entry.sha256,
            ]),
        ),
    });
}

/** Tally one assessment. */
function tally(summary: AssessmentSummary, assessment: StoredAssessment): void {
    summary.assessed += 1;
    switch (assessment.outcome) {
        case "pass":
            summary.pass += 1;
            break;
        case "fail":
            summary.fail += 1;
            break;
        default:
            summary.unknown += 1;
    }
    if (assessment.validity === "invalid") summary.invalid += 1;
    if (assessment.validity === "unrun") summary.unrun += 1;
}

/** The outcome of publishing one record. */
type StoreResult =
    | { ok: true; kind: "created" | "existing"; assessment: StoredAssessment }
    | { ok: false; problem: string };

/**
 * Publish an assessment immutably. Identical semantic content reuses the first
 * record (and its timestamp); different content is refused. The file is
 * written to a temporary name and linked into place, so a crash leaves either
 * no record or one complete record, never a partial authoritative file.
 * @param path The assessment path.
 * @param assessment The assessment to store.
 * @returns The stored record and whether this call created it.
 */
function storeAssessment(
    path: string,
    assessment: StoredAssessment,
): StoreResult {
    const text = `${JSON.stringify(assessment, null, 2)}\n`;
    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
            writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
        } catch (error) {
            return {
                ok: false,
                problem: `${path} could not be staged: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        try {
            linkSync(temporary, path);
            return { ok: true, kind: "created", assessment };
        } catch (error) {
            if (existsSync(path)) return compareWithExisting(path, assessment);
            return {
                ok: false,
                problem: `${path} could not be published: ${error instanceof Error ? error.message : String(error)}`,
            };
        } finally {
            rmSync(temporary, { force: true });
        }
    }
    return compareWithExisting(path, assessment);
}

/** Compare a new assessment with the record already at a path. */
function compareWithExisting(
    path: string,
    assessment: StoredAssessment,
): StoreResult {
    let existing: unknown;
    try {
        existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return {
            ok: false,
            problem: `${path} is unreadable; refusing to overwrite it`,
        };
    }
    if (!isRecord(existing)) {
        return {
            ok: false,
            problem: `${path} is not an assessment; refusing to overwrite it`,
        };
    }
    const stored = existing as unknown as StoredAssessment;
    return assessmentIdentity(stored) === assessmentIdentity(assessment)
        ? { ok: true, kind: "existing", assessment: stored }
        : {
              ok: false,
              problem: `${path} already holds a different assessment; historical assessments are immutable and the source evidence changed`,
          };
}

/** The number of ledger assessment events bound to one slot. */
function bindingsFor(ledger: LedgerRead, slotId: string): number {
    return ledger.events.filter(
        (event) => event.event === "assessment" && event.slotId === slotId,
    ).length;
}

/** A short synchronous wait for a concurrent binder to publish. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The ledger event a slot's assessment should be bound to, or null. */
function boundEvent(
    ledger: LedgerRead,
    slotId: string,
    assessment: StoredAssessment,
): LedgerEvent | null {
    return (
        ledger.events.find(
            (event) =>
                event.event === "assessment" &&
                event.slotId === slotId &&
                event.assessmentSha256 === sha256Of(assessment) &&
                event.outcome === assessment.outcome &&
                event.validity === assessment.validity &&
                event.attemptId === assessment.attemptId,
        ) ?? null
    );
}

/** Wait for a concurrent binder, bounded, and return the settled event. */
function awaitBinding(
    root: string,
    slotId: string,
    assessment: StoredAssessment,
): LedgerEvent | null {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const found = boundEvent(readLedger(root), slotId, assessment);
        if (found !== null) return found;
        sleepSync(10);
    }
    return null;
}

/** Record one created assessment in the ledger, exactly once. */
function bindAssessment(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    assessment: StoredAssessment;
}): string[] {
    const { root, manifest, slot, assessment } = options;
    const ledger = readLedger(root);
    if (bindingsFor(ledger, slot.slotId) > 1) {
        return [
            `slot ${slot.slotId} has more than one assessment ledger binding; refusing to add another`,
        ];
    }
    const bound = boundEvent(ledger, slot.slotId, assessment);
    if (bound !== null) return [];
    const lock = join(
        root,
        "evidence",
        "assessments",
        `${slot.slotId}.binding`,
    );
    let owned = false;
    try {
        writeFileSync(lock, `${process.pid}\n`, {
            encoding: "utf8",
            flag: "wx",
        });
        owned = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            return [
                `slot ${slot.slotId} binding lock failed: ${error instanceof Error ? error.message : String(error)}`,
            ];
        }
    }
    if (!owned) {
        return awaitBinding(root, slot.slotId, assessment) === null
            ? [`slot ${slot.slotId} assessment binding did not settle`]
            : [];
    }
    try {
        const fresh = readLedger(root);
        if (boundEvent(fresh, slot.slotId, assessment) !== null) return [];
        if (bindingsFor(fresh, slot.slotId) > 1) {
            return [
                `slot ${slot.slotId} has more than one assessment ledger binding; refusing to add another`,
            ];
        }
        appendLedgerEvent(
            root,
            {
                event: "assessment",
                campaignId: manifest.campaignId,
                slotId: slot.slotId,
                attemptId: assessment.attemptId,
                outcome: assessment.outcome,
                validity: assessment.validity,
                assessmentSha256: sha256Of(assessment),
            },
            assessment.assessedAt,
        );
        return [];
    } finally {
        rmSync(lock, { force: true });
    }
}

/** Post-close assessment is read-only: existing checked records only. */ /** Post-close assessment is read-only: existing checked records only. */
function readOnlyAssessment(
    root: string,
    manifest: PreparedManifest,
    ledger: LedgerRead,
    slotIds: readonly string[] | undefined,
): AssessResult {
    const checked = checkedAssessments({ root, manifest, ledger });
    const summary = emptySummary();
    const problems: string[] = [...checked.problems];
    const skipped: string[] = [];
    for (const entry of checked.records) {
        if (slotIds !== undefined && !slotIds.includes(entry.slotId)) continue;
        if (entry.state === "missing") {
            problems.push(
                `campaign is closed and slot ${entry.slotId} has no assessment`,
            );
            continue;
        }
        if (entry.state !== "valid" || entry.record === null) continue;
        if (entry.historical) {
            skipped.push(
                `slot ${entry.slotId} is a historical assessment; read only`,
            );
        }
        tally(summary, entry.record);
    }
    return {
        ok: problems.length === 0,
        summary,
        problems,
        skipped,
        stoppedAt: null,
    };
}

/** The outcome of attempting one slot without persisting an unrun state. */
interface SlotAssessment {
    assessment: StoredAssessment | null;
    problems: string[];
    skipped: string | null;
}

/** Assess and publish one slot, or explain why it is left alone. */
function assessSlot(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    now: () => string;
}): SlotAssessment {
    const { root, manifest, slot, now } = options;
    const trialDir = trialDirectory(root, slot.slotId);
    // Decide terminality before evaluating or reading the workspace at all.
    const claim = readClaims(join(root, "evidence"), "trial").find(
        (entry) => entry.stamp === slot.slotId,
    );
    if (claim !== undefined && claim.state !== "closed") {
        return {
            assessment: null,
            problems: [],
            skipped: `slot ${slot.slotId} trial attempt is not terminal (${claim.state}); no assessment written`,
        };
    }
    const assessment = assessmentForSlot(root, manifest, slot, now);
    if (assessment === null) {
        return {
            assessment: null,
            problems: [`slot ${slot.slotId} has no case ${slot.caseId}`],
            skipped: null,
        };
    }
    if (assessment.validity === "unrun") {
        return {
            assessment: null,
            problems: [],
            skipped: existsSync(join(trialDir, "launch.json"))
                ? `slot ${slot.slotId} is in flight; no assessment written`
                : `slot ${slot.slotId} has not run; no assessment written`,
        };
    }
    return { assessment, problems: [], skipped: null };
}

/** Publish one terminal assessment under the shared admission lock. */
function publishAssessment(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    assessment: StoredAssessment;
}): { assessment: StoredAssessment | null; problems: string[] } {
    const { root, manifest, slot, assessment } = options;
    const admitted = withAdmission(root, () => {
        const ledger = readLedger(root);
        if (ledger.state === "closed") {
            return {
                kind: "closed" as const,
                problems: [
                    `campaign is closed; slot ${slot.slotId} was not assessed`,
                ],
            };
        }
        if (ledger.state === "malformed") {
            return {
                kind: "malformed" as const,
                problems: [
                    `attempt ledger is malformed: ${ledger.problems.join("; ")}`,
                ],
            };
        }
        const stored = storeAssessment(
            assessmentPath(root, slot.slotId),
            assessment,
        );
        if (!stored.ok) {
            return { kind: "refused" as const, problems: [stored.problem] };
        }
        return {
            kind: "stored" as const,
            assessment: stored.assessment,
            problems: bindAssessment({
                root,
                manifest,
                slot,
                assessment: stored.assessment,
            }),
        };
    });
    if (!admitted.ok) {
        return { assessment: null, problems: [admitted.problem] };
    }
    return admitted.value.kind === "stored"
        ? {
              assessment: admitted.value.assessment,
              problems: admitted.value.problems,
          }
        : { assessment: null, problems: admitted.value.problems };
}

/**
 * Deterministically assess every scheduled slot from captured evidence.
 * Deterministic suites make zero model calls.
 * @param root The frozen campaign root.
 * @param options Slot selection and injected clock.
 * @param options.slotIds The selected slots; all when omitted.
 * @param options.now The injected clock for deterministic tests.
 * @returns Aggregate counts, skips and any refusals.
 */
export function assessCampaign(
    root: string,
    options: { slotIds?: readonly string[]; now?: () => string } = {},
): AssessResult {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) {
        return {
            ok: false,
            summary: emptySummary(),
            problems: [prepared.problem],
            skipped: [],
            stoppedAt: null,
        };
    }
    const manifest = prepared.manifest;
    const ledger = readLedger(root);
    const refusal = assessmentRefusal(root, ledger);
    if (refusal !== null) {
        return {
            ok: false,
            summary: emptySummary(),
            problems: [refusal],
            skipped: [],
            stoppedAt: null,
        };
    }
    if (ledger.state === "closed") {
        return readOnlyAssessment(root, manifest, ledger, options.slotIds);
    }
    // A frozen receipt alone does not authorise assessment: the prepared
    // inputs and the executing tool must still match the freeze.
    const drift = deliveryCheck(root);
    if (drift.length > 0) {
        return {
            ok: false,
            summary: emptySummary(),
            problems: ["delivery check failed", ...drift],
            skipped: [],
            stoppedAt: null,
        };
    }
    const selected = manifest.campaign.schedule.slots.filter(
        (slot) =>
            options.slotIds === undefined ||
            options.slotIds.includes(slot.slotId),
    );
    return assessSelected({
        root,
        manifest,
        ledger,
        slots: selected,
        now: options.now ?? (() => new Date().toISOString()),
    });
}

/** Assess the selected slots, persisting only real terminal evidence. */
function assessSelected(options: {
    root: string;
    manifest: PreparedManifest;
    ledger: LedgerRead;
    slots: readonly Slot[];
    now: () => string;
}): AssessResult {
    const summary = emptySummary();
    const problems: string[] = [];
    const skipped: string[] = [];
    let stoppedAt: string | null = null;
    for (const slot of options.slots) {
        const outcome = assessSlot({
            root: options.root,
            manifest: options.manifest,
            slot,
            now: options.now,
        });
        problems.push(...outcome.problems);
        if (outcome.skipped !== null) skipped.push(outcome.skipped);
        if (outcome.assessment === null) continue;
        const published = publishAssessment({
            root: options.root,
            manifest: options.manifest,
            slot,
            assessment: outcome.assessment,
        });
        problems.push(...published.problems);
        if (published.assessment === null) continue;
        tally(summary, published.assessment);
        if (assessShouldStop(options.manifest.campaign, published.assessment)) {
            stoppedAt = slot.slotId;
            break;
        }
    }
    return { ok: problems.length === 0, summary, problems, skipped, stoppedAt };
}

/**
 * Read every stored assessment without checking it.
 * @deprecated Use `checkedAssessments` from `src/evidence/assessments.ts`;
 * status, closure and reporting must not trust this unvalidated list.
 * @param root The campaign root.
 * @returns Parsed objects in filename order.
 */
export function readAssessments(root: string): StoredAssessment[] {
    const directory = join(root, "evidence", "assessments");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort(compareCodeUnits)
        .flatMap((name) => {
            try {
                const value: unknown = JSON.parse(
                    readFileSync(join(directory, name), "utf8"),
                );
                return isRecord(value)
                    ? [value as unknown as StoredAssessment]
                    : [];
            } catch {
                return [];
            }
        });
}
