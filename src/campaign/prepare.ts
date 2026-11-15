import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    copyFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
    canonicalJson,
    sha256Bytes,
    sha256Of,
} from "../contracts/canonical.ts";
import type {
    Arm,
    Campaign,
    CampaignBundle,
    Suite,
    SuiteCase,
} from "../contracts/types.ts";
import {
    isRecord,
    loadCampaignBundle,
    readJson,
} from "../contracts/validate.ts";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { inventory, stageTree, type Inventory } from "./inventory.ts";
import { toolIdentity, type ToolIdentity } from "../contracts/version.ts";

/** Resolve a declared local subject source. */
function sourcePath(
    base: string,
    path: string,
): { ok: true; path: string } | { ok: false; problem: string } {
    const resolved = isAbsolute(path) ? path : resolve(base, path);
    if (!existsSync(resolved)) {
        return { ok: false, problem: `${resolved} does not exist` };
    }
    try {
        return { ok: true, path: realpathSync(resolved) };
    } catch (error) {
        return {
            ok: false,
            problem: `${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** A staged arm: every source path is now a root-relative payload. */
export interface StagedArm {
    /** The arm id value. */
    armId: string;
    /** The skills value. */
    skills: Array<{ id: string; path: string }>;
    /** The plugins value. */
    plugins: Array<{ id: string; path: string; options?: unknown }>;
    /** The instructions value. */
    instructions: Array<{ id: string; path: string; as: string }>;
    /** The inventory value. */
    inventory: Inventory;
}

/** One prepared case: prompt and pristine workspace only. */
export interface PreparedCase {
    /** The case id value. */
    caseId: string;
    /** The prompt sha256 value. */
    promptSha256: string;
    /** The workspace value. */
    workspace: Inventory;
    /** The staged product primary check, when the case declares one. */
    primaryCheck?: {
        id: string;
        /** Root-relative staged directory. */
        directory: string;
        script: string;
        timeoutMs: number;
        inventory: Inventory;
    };
}

/** The immutable record of everything preparation staged. */
export interface PreparedManifest {
    /** The schema version value. */
    schemaVersion: 1;
    /** The campaign id value. */
    campaignId: string;
    /** The suite id value. */
    suiteId: string;
    /** The campaign sha256 value. */
    campaignSha256: string;
    /** The suite sha256 value. */
    suiteSha256: string;
    /** The suite canonical sha256 value. */
    suiteCanonicalSha256: string;
    /** The schedule sha256 value. */
    scheduleSha256: string;
    /** The subjects sha256 value. */
    subjectsSha256: string;
    /** The workspaces sha256 value. */
    workspacesSha256: string;
    /** The prompts sha256 value. */
    promptsSha256: string;
    /** The product primary-check payloads sha256; empty object when none. */
    primaryChecksSha256: string;
    /** The artefact that prepared this manifest. */
    tool: ToolIdentity;
    /** The suite value. */
    suite: Suite;
    /** The campaign value. */
    campaign: Campaign;
    /** The subjects value. */
    subjects: StagedArm[];
    /** The cases value. */
    cases: PreparedCase[];
}

/** The staging result, or the problems that prevented it. */
export type PrepareResult =
    | { ok: true; root: string; manifest: PreparedManifest }
    | { ok: false; problems: string[] };

/** Read and parse a JSON file that preparation just wrote. */
function readManifest(path: string): PreparedManifest | null {
    const parsed = readJson(path);
    if (!parsed.ok || !isRecord(parsed.value)) return null;
    return parsed.value as unknown as PreparedManifest;
}

/**
 * A campaign with source paths erased: identities are staged content, not the
 * developer's checkout paths.
 * @param bundle The validated campaign and suite.
 * @returns The normalised campaign stored in the manifest.
 */
export function normaliseCampaign(bundle: CampaignBundle): Campaign {
    const campaign: Campaign = {
        schemaVersion: 1,
        campaignId: bundle.campaign.campaignId,
        suite: {
            path: "suite.json",
            ...(bundle.declaredSuiteSha256 === null
                ? {}
                : { sha256: bundle.declaredSuiteSha256 }),
        },
        subjects: bundle.campaign.subjects.map((arm) => {
            const staged: Arm = { armId: arm.armId };
            if (arm.skills !== undefined) {
                staged.skills = arm.skills.map((skill) => ({
                    id: skill.id,
                    path: `subjects/${arm.armId}/skills/${skill.id}`,
                }));
            }
            if (arm.plugins !== undefined) {
                staged.plugins = arm.plugins.map((plugin) => ({
                    id: plugin.id,
                    path: `subjects/${arm.armId}/plugins/${plugin.id}`,
                    ...(plugin.include === undefined
                        ? {}
                        : { include: plugin.include }),
                    ...(plugin.options === undefined
                        ? {}
                        : { options: plugin.options }),
                }));
            }
            if (arm.instructions !== undefined) {
                staged.instructions = arm.instructions.map((instruction) => ({
                    id: instruction.id,
                    path: `subjects/${arm.armId}/instructions/${instruction.id}/${instruction.as ?? "AGENTS.md"}`,
                    as: instruction.as ?? "AGENTS.md",
                }));
            }
            return staged;
        }),
        schedule: bundle.campaign.schedule,
        runtime: bundle.campaign.runtime,
        budgets: bundle.campaign.budgets,
        assessment: bundle.campaign.assessment,
        ...(bundle.campaign.permissions === undefined
            ? {}
            : { permissions: bundle.campaign.permissions }),
        ...(bundle.campaign.stopOnFirstFailure === undefined
            ? {}
            : { stopOnFirstFailure: bundle.campaign.stopOnFirstFailure }),
    };
    return campaign;
}

/** Write a file, creating its parent directory. */
function write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
}

/** The default plugin members staged for the runtime. */
export const DEFAULT_PLUGIN_INCLUDE = [
    "package.json",
    "package-lock.json",
    "src",
    "dist",
    "node_modules",
    "CONVENTION.md",
    "README.md",
    "LICENSE",
] as const;

/** Validate one skill bundle's required shape. */
function skillProblem(directory: string): string | null {
    const entry = join(directory, "SKILL.md");
    if (!existsSync(entry)) return `${directory} has no SKILL.md`;
    if (!lstatSync(entry).isFile()) return `${entry} is not a file`;
    return null;
}

/** Reserve a staged target, refusing a collision. */
function reserve(
    reserved: Set<string>,
    target: string,
    armId: string,
    id: string,
    problems: string[],
): boolean {
    if (reserved.has(target)) {
        problems.push(`arm ${armId} has colliding subject ${id}`);
        return false;
    }
    reserved.add(target);
    return true;
}

/** Stage one skill bundle. */
function stageSkill(
    armId: string,
    skill: { id: string; path: string },
    bundleDir: string,
    destination: string,
    reserved: Set<string>,
    problems: string[],
): StagedArm["skills"][number] | null {
    const checked = sourcePath(bundleDir, skill.path);
    if (!checked.ok) {
        problems.push(`arm ${armId} skill ${skill.id}: ${checked.problem}`);
        return null;
    }
    const problem = skillProblem(checked.path);
    if (problem !== null) {
        problems.push(`arm ${armId} skill ${skill.id}: ${problem}`);
        return null;
    }
    const target = join(destination, "skills", skill.id);
    if (!reserve(reserved, target, armId, skill.id, problems)) return null;
    const staged = stageTree(checked.path, target);
    if (!staged.ok) {
        problems.push(`arm ${armId} skill ${skill.id}: ${staged.problem}`);
        return null;
    }
    return { id: skill.id, path: `subjects/${armId}/skills/${skill.id}` };
}

/** Stage one plugin package. */
function stagePlugin(
    armId: string,
    plugin: { id: string; path: string; include?: string[]; options?: unknown },
    bundleDir: string,
    destination: string,
    reserved: Set<string>,
    problems: string[],
): StagedArm["plugins"][number] | null {
    const checked = sourcePath(bundleDir, plugin.path);
    if (!checked.ok) {
        problems.push(`arm ${armId} plugin ${plugin.id}: ${checked.problem}`);
        return null;
    }
    if (!existsSync(join(checked.path, "package.json"))) {
        problems.push(
            `arm ${armId} plugin ${plugin.id}: package.json is missing`,
        );
        return null;
    }
    const target = join(destination, "plugins", plugin.id);
    if (!reserve(reserved, target, armId, plugin.id, problems)) return null;
    const include =
        plugin.include ??
        DEFAULT_PLUGIN_INCLUDE.filter((member) =>
            existsSync(join(checked.path, member)),
        );
    const staged = stageTree(checked.path, target, include);
    if (!staged.ok) {
        problems.push(`arm ${armId} plugin ${plugin.id}: ${staged.problem}`);
        return null;
    }
    return {
        id: plugin.id,
        path: `subjects/${armId}/plugins/${plugin.id}`,
        ...(plugin.options === undefined ? {} : { options: plugin.options }),
    };
}

/** Stage one instruction overlay. */
function stageInstruction(
    armId: string,
    instruction: { id: string; path: string; as?: string },
    bundleDir: string,
    root: string,
    reserved: Set<string>,
    problems: string[],
): StagedArm["instructions"][number] | null {
    const checked = sourcePath(bundleDir, instruction.path);
    if (!checked.ok) {
        problems.push(
            `arm ${armId} instruction ${instruction.id}: ${checked.problem}`,
        );
        return null;
    }
    if (!lstatSync(checked.path).isFile()) {
        problems.push(`arm ${armId} instruction ${instruction.id}: not a file`);
        return null;
    }
    const as = instruction.as ?? "AGENTS.md";
    const relativePath = `subjects/${armId}/instructions/${instruction.id}/${as}`;
    const target = join(root, "prepare", relativePath);
    if (!reserve(reserved, target, armId, instruction.id, problems)) {
        return null;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(checked.path, target);
    return { id: instruction.id, path: relativePath, as };
}

/** Stage one arm's declared subjects. */
function stageArm(
    arm: Arm,
    bundleDir: string,
    root: string,
    problems: string[],
): StagedArm | null {
    const destination = join(root, "prepare", "subjects", arm.armId);
    mkdirSync(destination, { recursive: true });
    const reserved = new Set<string>();
    const staged: StagedArm = {
        armId: arm.armId,
        skills: (arm.skills ?? []).flatMap((skill) => {
            const one = stageSkill(
                arm.armId,
                skill,
                bundleDir,
                destination,
                reserved,
                problems,
            );
            return one === null ? [] : [one];
        }),
        plugins: (arm.plugins ?? []).flatMap((plugin) => {
            const one = stagePlugin(
                arm.armId,
                plugin,
                bundleDir,
                destination,
                reserved,
                problems,
            );
            return one === null ? [] : [one];
        }),
        instructions: (arm.instructions ?? []).flatMap((instruction) => {
            const one = stageInstruction(
                arm.armId,
                instruction,
                bundleDir,
                root,
                reserved,
                problems,
            );
            return one === null ? [] : [one];
        }),
        inventory: [],
    };
    const armInventory = inventory(destination);
    if (!armInventory.ok) {
        problems.push(`arm ${arm.armId}: ${armInventory.problem}`);
        return null;
    }
    staged.inventory = armInventory.entries;
    return staged;
}

/** Stage one case's product primary checker, never into the trial payload. */
function stagePrimaryCheck(
    testCase: SuiteCase,
    suiteDir: string,
    root: string,
    problems: string[],
): PreparedCase["primaryCheck"] | undefined {
    if (testCase.kind !== "docs-task" || testCase.primaryCheck === undefined) {
        return undefined;
    }
    const spec = testCase.primaryCheck;
    const checked = sourcePath(suiteDir, spec.directory);
    if (!checked.ok) {
        problems.push(
            `case ${testCase.caseId} primary check: ${checked.problem}`,
        );
        return undefined;
    }
    if (!lstatSync(checked.path).isDirectory()) {
        problems.push(
            `case ${testCase.caseId} primary check: directory is not a directory`,
        );
        return undefined;
    }
    const relativePath = `primary-checks/${testCase.caseId}`;
    const target = join(root, "prepare", relativePath);
    const staged = stageTree(checked.path, target);
    if (!staged.ok) {
        problems.push(
            `case ${testCase.caseId} primary check: ${staged.problem}`,
        );
        return undefined;
    }
    const script = join(target, spec.script);
    if (!existsSync(script) || !lstatSync(script).isFile()) {
        problems.push(
            `case ${testCase.caseId} primary check: ${spec.script} is not a file`,
        );
        return undefined;
    }
    const stagedInventory = inventory(target);
    if (!stagedInventory.ok) {
        problems.push(
            `case ${testCase.caseId} primary check: ${stagedInventory.problem}`,
        );
        return undefined;
    }
    return {
        id: spec.id,
        directory: relativePath,
        script: spec.script,
        timeoutMs: spec.timeoutMs ?? 30_000,
        inventory: stagedInventory.entries,
    };
}

/** Stage one case's prompt, pristine workspace and optional checker. */
function stageCase(
    testCase: SuiteCase,
    suiteDir: string,
    root: string,
    problems: string[],
): PreparedCase | null {
    const prompt = testCase.prompt.endsWith("\n")
        ? testCase.prompt
        : `${testCase.prompt}\n`;
    write(join(root, "prepare", "prompts", `${testCase.caseId}.txt`), prompt);
    const workspace = join(root, "prepare", "workspaces", testCase.caseId);
    if (testCase.fixture !== undefined) {
        const checked = sourcePath(suiteDir, testCase.fixture);
        if (!checked.ok) {
            problems.push(`case ${testCase.caseId}: ${checked.problem}`);
            return null;
        }
        if (!lstatSync(checked.path).isDirectory()) {
            problems.push(
                `case ${testCase.caseId}: fixture is not a directory`,
            );
            return null;
        }
        const staged = stageTree(checked.path, workspace);
        if (!staged.ok) {
            problems.push(`case ${testCase.caseId}: ${staged.problem}`);
            return null;
        }
    } else {
        mkdirSync(workspace, { recursive: true });
    }
    for (const [path, contents] of Object.entries(testCase.files ?? {})) {
        write(join(workspace, path), contents);
    }
    const primaryCheck = stagePrimaryCheck(testCase, suiteDir, root, problems);
    const stagedWorkspace = inventory(workspace);
    if (!stagedWorkspace.ok) {
        problems.push(`case ${testCase.caseId}: ${stagedWorkspace.problem}`);
        return null;
    }
    return {
        caseId: testCase.caseId,
        promptSha256: sha256Bytes(
            readFileSync(
                join(root, "prepare", "prompts", `${testCase.caseId}.txt`),
            ),
        ),
        workspace: stagedWorkspace.entries,
        ...(primaryCheck === undefined ? {} : { primaryCheck }),
    };
}

/**
 * Validate a campaign, then stage an immutable root: suite, prompts, pristine
 * workspaces and subject payloads. Truth never enters a workspace.
 * @param campaignPath The campaign document.
 * @param root The fresh campaign root.
 * @returns The prepared manifest, or actionable problems.
 */
export function prepareCampaign(
    campaignPath: string,
    root: string,
): PrepareResult {
    const loaded = loadCampaignBundle(campaignPath);
    if (!loaded.ok) return { ok: false, problems: loaded.problems };
    const bundle = loaded.value;
    if (existsSync(root)) {
        return {
            ok: false,
            problems: [`${root} already exists; prepare needs a fresh root`],
        };
    }
    mkdirSync(root, { recursive: true });
    const problems: string[] = [];
    const suiteDir = dirname(bundle.suitePath);
    write(
        join(root, "prepare", "suite.json"),
        `${JSON.stringify(bundle.suite, null, 2)}\n`,
    );
    write(
        join(root, "prepare", "campaign.json"),
        readFileSync(bundle.campaignPath, "utf8"),
    );
    const subjects: StagedArm[] = [];
    for (const arm of bundle.campaign.subjects) {
        const staged = stageArm(
            arm,
            dirname(bundle.campaignPath),
            root,
            problems,
        );
        if (staged !== null) subjects.push(staged);
    }
    const cases: PreparedCase[] = [];
    for (const testCase of bundle.suite.cases) {
        const staged = stageCase(testCase, suiteDir, root, problems);
        if (staged !== null) cases.push(staged);
    }
    if (problems.length > 0) return { ok: false, problems };
    const campaign = normaliseCampaign(bundle);
    const subjectsSha256 = sha256Of(
        Object.fromEntries(subjects.map((arm) => [arm.armId, arm.inventory])),
    );
    const workspacesSha256 = sha256Of(
        Object.fromEntries(
            cases.map((testCase) => [testCase.caseId, testCase.workspace]),
        ),
    );
    const promptsSha256 = sha256Of(
        Object.fromEntries(
            cases.map((testCase) => [testCase.caseId, testCase.promptSha256]),
        ),
    );
    const primaryCheckEntries = cases.flatMap((testCase) =>
        testCase.primaryCheck === undefined
            ? []
            : [[testCase.caseId, testCase.primaryCheck.inventory] as const],
    );
    const manifest: PreparedManifest = {
        schemaVersion: 1,
        campaignId: bundle.campaign.campaignId,
        suiteId: bundle.suite.suiteId,
        campaignSha256: sha256Bytes(readFileSync(bundle.campaignPath)),
        suiteSha256: sha256Bytes(readFileSync(bundle.suitePath)),
        suiteCanonicalSha256: sha256Of(bundle.suite),
        scheduleSha256: sha256Of(bundle.campaign.schedule.slots),
        subjectsSha256,
        workspacesSha256,
        promptsSha256,
        primaryChecksSha256: sha256Of(Object.fromEntries(primaryCheckEntries)),
        tool: toolIdentity(),
        suite: bundle.suite,
        campaign,
        subjects,
        cases,
    };
    write(
        join(root, "prepare", "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return { ok: true, root, manifest };
}

/** The hash of a prepared manifest's canonical content. */
export function manifestSha256(manifest: PreparedManifest): string {
    return sha256Of(manifest);
}

/** Read the prepared manifest. */
export function loadPreparedManifest(
    root: string,
): { ok: true; manifest: PreparedManifest } | { ok: false; problem: string } {
    const path = join(root, "prepare", "manifest.json");
    if (!existsSync(path)) {
        return { ok: false, problem: `${path} is missing; run otc prepare` };
    }
    const manifest = readManifest(path);
    if (manifest === null) {
        return { ok: false, problem: `${path} is not a readable manifest` };
    }
    if (manifest.schemaVersion !== 1) {
        return {
            ok: false,
            problem: `${path} has an unsupported schemaVersion`,
        };
    }
    return { ok: true, manifest };
}

/**
 * Recheck every staged payload against the prepared manifest.
 * @param root The campaign root.
 * @param manifest The prepared manifest.
 * @returns Differences; empty means the payload is intact.
 */
export function preparedDifferences(
    root: string,
    manifest: PreparedManifest,
): string[] {
    const problems: string[] = [];
    const suitePath = join(root, "prepare", "suite.json");
    if (!existsSync(suitePath)) {
        problems.push("missing prepare/suite.json");
    } else {
        const observed = sha256Bytes(readFileSync(suitePath));
        if (
            observed !==
            sha256Bytes(`${JSON.stringify(manifest.suite, null, 2)}\n`)
        ) {
            problems.push("changed prepare/suite.json");
        }
    }
    for (const arm of manifest.subjects) {
        const directory = join(root, "prepare", "subjects", arm.armId);
        for (const difference of inventoryDifferencesOf(
            directory,
            arm.inventory,
        )) {
            problems.push(`subjects/${arm.armId}: ${difference}`);
        }
    }
    for (const testCase of manifest.cases) {
        const workspace = join(root, "prepare", "workspaces", testCase.caseId);
        for (const difference of inventoryDifferencesOf(
            workspace,
            testCase.workspace,
        )) {
            problems.push(`workspaces/${testCase.caseId}: ${difference}`);
        }
        const promptProblem = promptDifference(root, testCase);
        if (promptProblem !== null) problems.push(promptProblem);
        problems.push(...primaryCheckDifferences(root, testCase));
    }
    return problems;
}

/** The prompt identity difference for one case, or null when intact. */
function promptDifference(root: string, testCase: PreparedCase): string | null {
    const prompt = join(root, "prepare", "prompts", `${testCase.caseId}.txt`);
    if (!existsSync(prompt)) return `missing prompts/${testCase.caseId}.txt`;
    return sha256Bytes(readFileSync(prompt)) !== testCase.promptSha256
        ? `changed prompts/${testCase.caseId}.txt`
        : null;
}

/** The staged primary-check differences for one case. */
function primaryCheckDifferences(
    root: string,
    testCase: PreparedCase,
): string[] {
    if (testCase.primaryCheck === undefined) return [];
    const checker = join(root, "prepare", testCase.primaryCheck.directory);
    return inventoryDifferencesOf(checker, testCase.primaryCheck.inventory).map(
        (difference) => `primary-checks/${testCase.caseId}: ${difference}`,
    );
}

/** Inventory differences with a missing-directory distinction. */
function inventoryDifferencesOf(root: string, expected: Inventory): string[] {
    if (!existsSync(root)) return ["directory is missing"];
    const observed = inventory(root);
    if (!observed.ok) return [observed.problem];
    const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
    const observedMap = new Map(
        observed.entries.map((entry) => [entry.path, entry]),
    );
    const problems: string[] = [];
    for (const [path, entry] of expectedMap) {
        const found = observedMap.get(path);
        if (found === undefined) problems.push(`missing ${path}`);
        else if (found.sha256 !== entry.sha256)
            problems.push(`changed ${path}`);
    }
    for (const path of observedMap.keys()) {
        if (!expectedMap.has(path)) problems.push(`added ${path}`);
    }
    return problems;
}

/** The canonical text of a prepared manifest, for receipts and displays. */
export function manifestText(manifest: PreparedManifest): string {
    return canonicalJson(manifest);
}

/** A human-readable staging summary. */
export function prepareSummary(manifest: PreparedManifest): string {
    return [
        `campaign ${manifest.campaignId} (suite ${manifest.suiteId})`,
        `${manifest.subjects.length} arm(s), ${manifest.cases.length} case(s)`,
        `manifest ${manifestSha256(manifest)}`,
    ].join("\n");
}

/** A path's basename, used in diagnostics without exposing an absolute path. */
export function displayPath(path: string): string {
    return basename(resolve(path));
}
