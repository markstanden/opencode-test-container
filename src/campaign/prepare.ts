import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
    copyFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
    canonicalJson,
    sha256Bytes,
    sha256Of,
} from "../contracts/canonical.ts";
import type {
    Arm,
    Campaign,
    CampaignBundle,
    ObservedCampaignBundle,
    Suite,
    SuiteCase,
} from "../contracts/types.ts";
import {
    isRecord,
    loadCampaignBundle,
    readJson,
} from "../contracts/validate.ts";
import {
    inventory,
    inventoryDifferences,
    stageTree,
    type Inventory,
} from "./inventory.ts";
import { toolIdentity, type ToolIdentity } from "../contracts/version.ts";
import { canonicalPath, pathWithin } from "../evidence/paths.ts";

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
    /**
     * The inventory format these entries use. Version 2 records execute bits
     * and empty directories; an absent field is a historical version 1
     * manifest and is compared with version 1 semantics.
     */
    inventoryVersion?: 2;
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
        ...(bundle.campaign.stopPolicy === undefined
            ? {}
            : { stopPolicy: bundle.campaign.stopPolicy }),
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
    "index.js",
    "index.ts",
    "server.js",
    "server.ts",
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
    const armInventory = inventory(destination, { version: 2 });
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
    const stagedInventory = inventory(target, { version: 2 });
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
    const stagedWorkspace = inventory(workspace, { version: 2 });
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

/** The subject documents declared by every arm. */
function subjectInputs(bundle: CampaignBundle): string[] {
    const campaignDir = dirname(bundle.campaignPath);
    return bundle.campaign.subjects.flatMap((arm) => [
        ...[...(arm.skills ?? []), ...(arm.plugins ?? [])].map((subject) =>
            resolve(campaignDir, subject.path),
        ),
        ...(arm.instructions ?? []).map((instruction) =>
            resolve(campaignDir, instruction.path),
        ),
    ]);
}

/** The suite-relative fixtures and checkers declared by every case. */
function caseInputs(bundle: CampaignBundle): string[] {
    const suiteDir = dirname(bundle.suitePath);
    return bundle.suite.cases.flatMap((testCase) => [
        ...(testCase.fixture === undefined
            ? []
            : [resolve(suiteDir, testCase.fixture)]),
        ...(testCase.kind === "docs-task" && testCase.primaryCheck !== undefined
            ? [resolve(suiteDir, testCase.primaryCheck.directory)]
            : []),
    ]);
}

/** Resolve one existing input, or nothing when it is already missing. */
function realInput(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
        return [realpathSync(path)];
    } catch {
        return [];
    }
}

/**
 * Every existing input path preparation will stage, resolved to its real
 * location. Overlap is decided before anything is created.
 * @param bundle The validated campaign bundle.
 * @returns Real input paths.
 */
function stagedInputs(bundle: CampaignBundle): string[] {
    return [
        bundle.campaignPath,
        bundle.suitePath,
        ...subjectInputs(bundle),
        ...caseInputs(bundle),
    ].flatMap(realInput);
}

/**
 * Refuse a proposed root that overlaps a staged input: a root inside a fixture
 * would be staged into itself, and a root containing an input would destroy or
 * absorb it.
 * @param root The proposed campaign root.
 * @param inputs The real input paths.
 * @returns Problems; empty means the root is independent.
 */
function overlapProblems(root: string, inputs: readonly string[]): string[] {
    const destination = canonicalPath(root);
    return inputs.flatMap((input) => {
        if (pathWithin(input, destination)) {
            return [`${root} is inside staged input ${input}`];
        }
        if (pathWithin(destination, input)) {
            return [`${root} contains staged input ${input}`];
        }
        return [];
    });
}

/** Stage every arm and case into the claimed root, collecting problems. */
function stageBundle(
    bundle: CampaignBundle,
    root: string,
): { subjects: StagedArm[]; cases: PreparedCase[]; problems: string[] } {
    const problems: string[] = [];
    const suiteDir = dirname(bundle.suitePath);
    const campaignDir = dirname(bundle.campaignPath);
    const subjects = bundle.campaign.subjects
        .map((arm) => stageArm(arm, campaignDir, root, problems))
        .filter((arm): arm is StagedArm => arm !== null);
    const cases = bundle.suite.cases
        .map((testCase) => stageCase(testCase, suiteDir, root, problems))
        .filter((testCase): testCase is PreparedCase => testCase !== null);
    return { subjects, cases, problems };
}

/** The manifest for one fully staged bundle. */
function manifestFor(
    bundle: ObservedCampaignBundle,
    subjects: StagedArm[],
    cases: PreparedCase[],
    tool: ToolIdentity,
): PreparedManifest {
    const primaryCheckEntries = cases.flatMap((testCase) =>
        testCase.primaryCheck === undefined
            ? []
            : [[testCase.caseId, testCase.primaryCheck.inventory] as const],
    );
    return {
        schemaVersion: 1,
        inventoryVersion: 2,
        campaignId: bundle.campaign.campaignId,
        suiteId: bundle.suite.suiteId,
        campaignSha256: bundle.campaignSha256,
        suiteSha256: bundle.suiteSha256,
        suiteCanonicalSha256: sha256Of(bundle.suite),
        scheduleSha256: sha256Of(bundle.campaign.schedule.slots),
        subjectsSha256: sha256Of(
            Object.fromEntries(
                subjects.map((arm) => [arm.armId, arm.inventory]),
            ),
        ),
        workspacesSha256: sha256Of(
            Object.fromEntries(
                cases.map((testCase) => [testCase.caseId, testCase.workspace]),
            ),
        ),
        promptsSha256: sha256Of(
            Object.fromEntries(
                cases.map((testCase) => [
                    testCase.caseId,
                    testCase.promptSha256,
                ]),
            ),
        ),
        primaryChecksSha256: sha256Of(Object.fromEntries(primaryCheckEntries)),
        tool,
        suite: bundle.suite,
        campaign: normaliseCampaign(bundle),
        subjects,
        cases,
    };
}

/**
 * Create missing parents, then claim the final root directory exclusively.
 * @param root The proposed campaign root.
 * @returns A refusal, or null when this invocation now owns a fresh root.
 */
function claimRoot(root: string): string | null {
    if (existsSync(root)) {
        return `${root} already exists; prepare needs a fresh root`;
    }
    try {
        mkdirSync(dirname(resolve(root)), { recursive: true });
    } catch (error) {
        return `${root} could not be created: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
        mkdirSync(root, { recursive: false });
        return null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return `${root} already exists; prepare needs a fresh root`;
        }
        return `${root} could not be created: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/** Remove only a root this invocation created, then report the refusal. */
function refuseCreated(root: string, problems: string[]): PrepareResult {
    rmSync(root, { recursive: true, force: true });
    return { ok: false, problems };
}

/** Preparation's optional observation and attribution seams. */
export interface PrepareOptions {
    /**
     * Reads one original campaign or suite document. Injected by read-count
     * tests; production uses `readFileSync`.
     */
    readDocument?: (path: string) => Buffer;
    /** The recorded tool identity; sampled once when omitted. */
    tool?: ToolIdentity;
}

/**
 * Validate a campaign, then stage an immutable root: suite, prompts, pristine
 * workspaces and subject payloads. Truth never enters a workspace.
 *
 * The root is claimed with an atomic `mkdir`; a pre-existing root is never
 * removed. A refusal after this call created the root removes only this
 * invocation's provisional tree, so a corrected invocation can retry at the
 * same path.
 * @param campaignPath The campaign document.
 * @param root The fresh campaign root.
 * @param options Observation and attribution seams for deterministic tests.
 * @returns The prepared manifest, or actionable problems.
 */
export function prepareCampaign(
    campaignPath: string,
    root: string,
    options: PrepareOptions = {},
): PrepareResult {
    const loaded = loadCampaignBundle(
        campaignPath,
        options.readDocument ?? readFileSync,
    );
    if (!loaded.ok) return { ok: false, problems: loaded.problems };
    const bundle = loaded.value;
    const tool = options.tool ?? toolIdentity();
    const overlap = overlapProblems(root, stagedInputs(bundle));
    if (overlap.length > 0) {
        return {
            ok: false,
            problems: [...overlap, "choose a root outside every staged input"],
        };
    }
    const claim = claimRoot(root);
    if (claim !== null) return { ok: false, problems: [claim] };
    try {
        write(
            join(root, "prepare", "suite.json"),
            `${JSON.stringify(bundle.suite, null, 2)}\n`,
        );
        write(join(root, "prepare", "campaign.json"), bundle.campaignText);
        const staged = stageBundle(bundle, root);
        if (staged.problems.length > 0) {
            return refuseCreated(root, staged.problems);
        }
        const manifest = manifestFor(
            bundle,
            staged.subjects,
            staged.cases,
            tool,
        );
        write(
            join(root, "prepare", "manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
        );
        return { ok: true, root, manifest };
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
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
    const version = manifest.inventoryVersion === 2 ? 2 : 1;
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
        for (const difference of inventoryDifferences(
            directory,
            arm.inventory,
            { version },
        )) {
            problems.push(`subjects/${arm.armId}: ${difference}`);
        }
    }
    for (const testCase of manifest.cases) {
        const workspace = join(root, "prepare", "workspaces", testCase.caseId);
        for (const difference of inventoryDifferences(
            workspace,
            testCase.workspace,
            { version },
        )) {
            problems.push(`workspaces/${testCase.caseId}: ${difference}`);
        }
        const promptProblem = promptDifference(root, testCase);
        if (promptProblem !== null) problems.push(promptProblem);
        problems.push(...primaryCheckDifferences(root, testCase, version));
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
    version: 1 | 2,
): string[] {
    if (testCase.primaryCheck === undefined) return [];
    const checker = join(root, "prepare", testCase.primaryCheck.directory);
    return inventoryDifferences(checker, testCase.primaryCheck.inventory, {
        version,
    }).map((difference) => `primary-checks/${testCase.caseId}: ${difference}`);
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
