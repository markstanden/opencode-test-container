import {
    existsSync,
    linkSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sha256Bytes, sha256Of } from "../contracts/canonical.ts";
import { isRecord, readJson } from "../contracts/validate.ts";
import { resolveImage, type ResolvedImage } from "../adapters/podman/image.ts";
import { runCommand } from "../adapters/process.ts";
import {
    loadPreparedManifest,
    manifestSha256,
    preparedDifferences,
    type PreparedManifest,
} from "./prepare.ts";
import {
    toolIdentity,
    toolIdentityProblems,
    type ToolIdentity,
} from "../contracts/version.ts";

/** The immutable freeze receipt. */
export interface FrozenRecord {
    /** The schema version value. */
    schemaVersion: 1;
    /** The kind value. */
    kind: "otc-freeze";
    /** The campaign id value. */
    campaignId: string;
    /** The suite id value. */
    suiteId: string;
    /** The freeze sha256 value. */
    freezeSha256: string;
    /** The manifest sha256 value. */
    manifestSha256: string;
    /** The campaign sha256 value. */
    campaignSha256: string;
    /** The suite sha256 value. */
    suiteSha256: string;
    /** The schedule sha256 value. */
    scheduleSha256: string;
    /** The subjects sha256 value. */
    subjectsSha256: string;
    /** The workspaces sha256 value. */
    workspacesSha256: string;
    /** The prompts sha256 value. */
    promptsSha256: string;
    /** The staged primary-check payload sha256 value. */
    primaryChecksSha256: string;
    /** The artefact that froze this campaign. */
    tool: ToolIdentity;
    /** The image value. */
    image: string;
    /** The image id value. */
    imageId: string;
    /** The opencode version value. */
    opencodeVersion: string;
    /** The provider value. */
    provider: { route: string; model: string };
    /** The frozen at value. */
    frozenAt: string;
}

/** A freeze attempt's outcome. */
export type FreezeResult =
    | { ok: true; record: FrozenRecord; alreadyFrozen: boolean }
    | { ok: false; problems: string[] };

/** The freeze fields whose change must refuse a later freeze/run. */
export type FreezeIdentity = Omit<FrozenRecord, "freezeSha256" | "frozenAt">;

/** The canonical freeze identity, independent of the freeze timestamp. */
export function freezeIdentity(record: FreezeIdentity): string {
    return sha256Of(record);
}

/** Path of the freeze receipt. */
export function frozenPath(root: string): string {
    return join(root, "prepare", "frozen.json");
}

/** The required string fields of a freeze record. */
const FROZEN_TEXT_FIELDS = [
    "campaignId",
    "suiteId",
    "freezeSha256",
    "manifestSha256",
    "campaignSha256",
    "suiteSha256",
    "scheduleSha256",
    "subjectsSha256",
    "workspacesSha256",
    "promptsSha256",
    "primaryChecksSha256",
    "image",
    "imageId",
    "opencodeVersion",
    "frozenAt",
] as const;

/** Check the freeze record's tool identity shape. */
function toolShapeProblems(tool: unknown, path: string): string[] {
    return !isRecord(tool) ||
        typeof tool.name !== "string" ||
        typeof tool.version !== "string" ||
        typeof tool.evaluatorVersion !== "number" ||
        typeof tool.artifactSha256 !== "string"
        ? [
              `${path}.tool must name name, version, evaluatorVersion and artifactSha256`,
          ]
        : [];
}

/** Check a freeze record's shape. */
function frozenShapeProblems(
    record: Record<string, unknown>,
    path: string,
): string[] {
    const problems = FROZEN_TEXT_FIELDS.filter(
        (field) => typeof record[field] !== "string",
    ).map((field) => `${path}.${field} must be a string`);
    if (
        !isRecord(record.provider) ||
        typeof record.provider.route !== "string" ||
        typeof record.provider.model !== "string"
    ) {
        problems.push(`${path}.provider must name route and model`);
    }
    problems.push(...toolShapeProblems(record.tool, path));
    if (record.schemaVersion !== 1 || record.kind !== "otc-freeze") {
        problems.push(`${path} is not a schemaVersion 1 otc-freeze record`);
    }
    return problems;
}

/**
 * Read a freeze receipt without trusting its shape.
 * @param root The campaign root.
 * @returns The record, or the reason it is unusable.
 */
export function loadFrozen(
    root: string,
): { ok: true; record: FrozenRecord } | { ok: false; problem: string } {
    const path = frozenPath(root);
    if (!existsSync(path)) {
        return { ok: false, problem: `${path} is missing; run otc freeze` };
    }
    const parsed = readJson(path);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };
    if (!isRecord(parsed.value)) {
        return { ok: false, problem: `${path} is not an object` };
    }
    const problems = frozenShapeProblems(parsed.value, path);
    if (problems.length > 0) {
        return { ok: false, problem: problems.join("; ") };
    }
    const typed = parsed.value as unknown as FrozenRecord;
    if (freezeIdentity(identityOf(typed)) !== typed.freezeSha256) {
        return {
            ok: false,
            problem: `${path} freezeSha256 does not match its content`,
        };
    }
    return { ok: true, record: typed };
}

/** Strip volatile and derived fields from a freeze record. */
export function identityOf(record: FrozenRecord): FreezeIdentity {
    return {
        schemaVersion: record.schemaVersion,
        kind: record.kind,
        campaignId: record.campaignId,
        suiteId: record.suiteId,
        manifestSha256: record.manifestSha256,
        campaignSha256: record.campaignSha256,
        suiteSha256: record.suiteSha256,
        scheduleSha256: record.scheduleSha256,
        subjectsSha256: record.subjectsSha256,
        workspacesSha256: record.workspacesSha256,
        promptsSha256: record.promptsSha256,
        primaryChecksSha256: record.primaryChecksSha256,
        tool: record.tool,
        image: record.image,
        imageId: record.imageId,
        opencodeVersion: record.opencodeVersion,
        provider: record.provider,
    };
}

/** Compare prepared inputs with a freeze receipt. */
export function freezeDifferences(
    manifest: PreparedManifest,
    frozen: FrozenRecord,
    current: ToolIdentity = toolIdentity(),
): string[] {
    const observed: FreezeIdentity = {
        schemaVersion: 1,
        kind: "otc-freeze",
        campaignId: manifest.campaignId,
        suiteId: manifest.suiteId,
        manifestSha256: manifestSha256(manifest),
        campaignSha256: manifest.campaignSha256,
        suiteSha256: manifest.suiteSha256,
        scheduleSha256: manifest.scheduleSha256,
        subjectsSha256: manifest.subjectsSha256,
        workspacesSha256: manifest.workspacesSha256,
        promptsSha256: manifest.promptsSha256,
        primaryChecksSha256: manifest.primaryChecksSha256,
        tool: current,
        image: manifest.campaign.runtime.image,
        imageId: manifest.campaign.runtime.imageId ?? frozen.imageId,
        opencodeVersion: manifest.campaign.runtime.opencodeVersion,
        provider: {
            route: manifest.campaign.runtime.provider.route,
            model: manifest.campaign.runtime.provider.model,
        },
    };
    const differences: string[] = [];
    for (const field of Object.keys(observed) as Array<keyof FreezeIdentity>) {
        let same: boolean;
        if (field === "imageId") {
            same =
                String(observed[field]).replace(/^sha256:/, "") ===
                String(frozen[field]).replace(/^sha256:/, "");
        } else if (typeof observed[field] === "object") {
            same = sha256Of(observed[field]) === sha256Of(frozen[field]);
        } else {
            same = observed[field] === frozen[field];
        }
        if (!same) {
            differences.push(`frozen ${field} no longer holds`);
        }
    }
    return differences;
}

/** Check that prepared files and the stored campaign copy are intact. */
export function inputDifferences(
    root: string,
    manifest: PreparedManifest,
): string[] {
    const problems = preparedDifferences(root, manifest);
    const campaign = join(root, "prepare", "campaign.json");
    if (!existsSync(campaign)) {
        problems.push("missing prepare/campaign.json");
    } else if (
        sha256Bytes(readFileSync(campaign)) !== manifest.campaignSha256
    ) {
        problems.push("changed prepare/campaign.json");
    }
    return problems;
}

/** The state of an existing freeze receipt, if one exists. */
function existingFreeze(
    root: string,
    manifest: PreparedManifest,
    current: ToolIdentity,
):
    | { kind: "none" }
    | { kind: "ok"; record: FrozenRecord }
    | { kind: "refuse"; problems: string[] } {
    if (!existsSync(frozenPath(root))) return { kind: "none" };
    const existing = loadFrozen(root);
    if (!existing.ok) {
        return {
            kind: "refuse",
            problems: [existing.problem],
        };
    }
    const drift = freezeDifferences(manifest, existing.record, current);
    return drift.length === 0
        ? { kind: "ok", record: existing.record }
        : {
              kind: "refuse",
              problems: [
                  "already frozen with different inputs; use a fresh root",
                  ...drift,
              ],
          };
}

/**
 * Publish a complete freeze receipt with create-if-absent semantics.
 *
 * The receipt is written to a sibling temporary file and hard-linked into
 * place, so a reader never observes a partial receipt and exactly one writer
 * can create it. `link` failing with `EEXIST` is the arbitration point, not an
 * error: the caller re-reads the durable receipt and converges or refuses.
 * @param root The prepared campaign root.
 * @param record The complete receipt to publish.
 * @returns Whether this caller published it, or another receipt was already there.
 */
function publishFrozen(
    root: string,
    record: FrozenRecord,
):
    | { kind: "published" }
    | { kind: "exists" }
    | { kind: "refused"; problem: string } {
    const target = frozenPath(root);
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
        writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    } catch (error) {
        rmSync(temporary, { force: true });
        return {
            kind: "refused",
            problem: `the freeze receipt could not be staged: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    try {
        linkSync(temporary, target);
        return { kind: "published" };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return { kind: "exists" };
        }
        return {
            kind: "refused",
            problem: `the freeze receipt could not be published: ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        rmSync(temporary, { force: true });
    }
}

/** The prepared, unchanged payload and the executing tool identity. */
function freezePreflight(
    root: string,
):
    | { ok: true; manifest: PreparedManifest; current: ToolIdentity }
    | { ok: false; problems: string[] } {
    const loaded = loadPreparedManifest(root);
    if (!loaded.ok) return { ok: false, problems: [loaded.problem] };
    const manifest = loaded.manifest;
    const differences = inputDifferences(root, manifest);
    if (differences.length > 0) {
        return {
            ok: false,
            problems: [
                "prepared payload does not match its manifest",
                ...differences,
            ],
        };
    }
    if (manifest.tool === undefined) {
        return {
            ok: false,
            problems: [
                "prepared manifest has no tool identity; prepare a fresh root",
            ],
        };
    }
    const current = toolIdentity();
    const toolDrift = toolIdentityProblems(manifest.tool, current);
    return toolDrift.length > 0
        ? {
              ok: false,
              problems: [
                  "prepared payload was produced by a different executing tool",
                  ...toolDrift,
              ],
          }
        : { ok: true, manifest, current };
}

/** The complete receipt for one resolved image. */
export function receiptFor(
    manifest: PreparedManifest,
    current: ToolIdentity,
    image: ResolvedImage,
    frozenAt: string,
): FrozenRecord {
    const identity: FreezeIdentity = {
        schemaVersion: 1,
        kind: "otc-freeze",
        campaignId: manifest.campaignId,
        suiteId: manifest.suiteId,
        manifestSha256: manifestSha256(manifest),
        campaignSha256: manifest.campaignSha256,
        suiteSha256: manifest.suiteSha256,
        scheduleSha256: manifest.scheduleSha256,
        subjectsSha256: manifest.subjectsSha256,
        workspacesSha256: manifest.workspacesSha256,
        promptsSha256: manifest.promptsSha256,
        primaryChecksSha256: manifest.primaryChecksSha256,
        tool: current,
        image: manifest.campaign.runtime.image,
        imageId: image.imageId,
        opencodeVersion: image.opencodeVersion,
        provider: {
            route: manifest.campaign.runtime.provider.route,
            model: manifest.campaign.runtime.provider.model,
        },
    };
    return {
        ...identity,
        freezeSha256: freezeIdentity(identity),
        frozenAt,
    };
}

/**
 * Converge on a receipt another caller published. Only the same resolved
 * identity is acceptable; a different image can never both succeed.
 */
function convergeFreeze(
    root: string,
    manifest: PreparedManifest,
    current: ToolIdentity,
    record: FrozenRecord,
    image: ResolvedImage,
): FreezeResult {
    const winner = loadFrozen(root);
    if (!winner.ok) {
        return {
            ok: false,
            problems: [
                "another freeze published a receipt that is not readable",
                winner.problem,
            ],
        };
    }
    if (freezeIdentity(identityOf(winner.record)) !== record.freezeSha256) {
        return {
            ok: false,
            problems: [
                "another freeze already published a different receipt",
                `observed image ${winner.record.imageId}, this caller resolved ${image.imageId}`,
                ...freezeDifferences(manifest, winner.record, current),
            ],
        };
    }
    return { ok: true, record: winner.record, alreadyFrozen: true };
}

/**
 * Freeze a prepared campaign: resolve the image to its immutable identity,
 * verify the CLI version it contains, and record all input identities.
 * @param root The prepared campaign root.
 * @param run Process adapter, injected for tests.
 * @param now Injected clock for the recorded frozenAt.
 * @returns The receipt, or every refusal.
 */
export async function freezeCampaign(
    root: string,
    run: typeof runCommand = runCommand,
    now: () => string = () => new Date().toISOString(),
): Promise<FreezeResult> {
    const preflight = freezePreflight(root);
    if (!preflight.ok) return preflight;
    const { manifest, current } = preflight;
    const existing = existingFreeze(root, manifest, current);
    if (existing.kind === "ok") {
        return { ok: true, record: existing.record, alreadyFrozen: true };
    }
    if (existing.kind === "refuse") {
        return { ok: false, problems: existing.problems };
    }
    const resolved = await resolveImage(
        manifest.campaign.runtime.imageId ?? manifest.campaign.runtime.image,
        manifest.campaign.runtime.opencodeVersion,
        run,
    );
    if (!resolved.ok) return { ok: false, problems: [resolved.problem] };
    const image = resolved.image;
    const record = receiptFor(manifest, current, image, now());
    const published = publishFrozen(root, record);
    if (published.kind === "refused") {
        return { ok: false, problems: [published.problem] };
    }
    return published.kind === "published"
        ? { ok: true, record, alreadyFrozen: false }
        : convergeFreeze(root, manifest, current, record, image);
}

/**
 * The read-only delivery check: is the frozen payload complete and unchanged?
 * @param root The campaign root.
 * @returns Differences; empty means delivery is intact.
 */
export function deliveryCheck(
    root: string,
    current: ToolIdentity = toolIdentity(),
): string[] {
    const frozen = loadFrozen(root);
    const prepared = loadPreparedManifest(root);
    if (!frozen.ok) return [frozen.problem];
    if (!prepared.ok) return [prepared.problem];
    const problems = inputDifferences(root, prepared.manifest);
    if (manifestSha256(prepared.manifest) !== frozen.record.manifestSha256) {
        problems.push("prepared manifest does not match the freeze");
    }
    for (const difference of freezeDifferences(
        prepared.manifest,
        frozen.record,
        current,
    )) {
        problems.push(difference);
    }
    problems.push(...toolIdentityProblems(frozen.record.tool, current));
    for (const arm of prepared.manifest.subjects) {
        if (arm.plugins.length > 0) {
            for (const plugin of arm.plugins) {
                const packageJson = join(
                    root,
                    "prepare",
                    plugin.path,
                    "package.json",
                );
                if (!existsSync(packageJson)) {
                    problems.push(
                        `arm ${arm.armId}: plugin ${plugin.id} has no package.json`,
                    );
                }
            }
        }
    }
    return problems;
}
