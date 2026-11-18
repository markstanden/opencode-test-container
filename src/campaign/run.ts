import { randomBytes } from "node:crypto";
import {
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Bytes, sha256Of } from "../contracts/canonical.ts";
import type { ToolIdentity } from "../contracts/version.ts";
import type { Arm, Campaign, Slot, SuiteCase } from "../contracts/types.ts";
import {
    decodeTrail,
    captureProblems,
    type DecodedTrail,
} from "../adapters/opencode/events.ts";
import {
    environmentFileProblems,
    environmentFileText,
    opencodeRunArgs,
    providerOverlay,
    sessionEnv,
    writeConfigHome,
} from "../adapters/opencode/runtime.ts";
import {
    CONTAINER_CONFIG_HOME,
    CONTAINER_JOURNAL,
    CONTAINER_SUBJECTS,
    CONTAINER_WORKSPACE,
    normaliseMounts,
    ownedContainerName,
    runContainer,
    type ContainerPlan,
    type Mount,
} from "../adapters/podman/container.ts";
import type { CommandResult } from "../adapters/process.ts";
import { deliveryCheck, loadFrozen, type FrozenRecord } from "./freeze.ts";
import { stageTree } from "./inventory.ts";
import { containedEntry } from "../evidence/containment.ts";
import { executePrimaryCheck, type PrimaryCheckRecord } from "./primary.ts";
import { runShouldStop } from "./stop-policy.ts";
import { withAdmission } from "./admission.ts";
import { appendLedgerEvent, readLedger, startedSlots } from "./ledger.ts";
import {
    advanceClaim,
    claimBudget,
    releaseClaim,
    type BudgetClaim,
} from "./budget.ts";
import {
    loadPreparedManifest,
    type PreparedManifest,
    type StagedArm,
} from "./prepare.ts";

/** The receipt written before any dispatch. */
export interface LaunchReceipt {
    /** The schema version value. */
    schemaVersion: 1;
    /** The campaign id value. */
    campaignId: string;
    /** The slot id value. */
    slotId: string;
    /** The case id value. */
    caseId: string;
    /** The arm id value. */
    armId: string;
    /** The repetition id value. */
    repetitionId: string;
    /** The image id value. */
    imageId: string;
    /** The prompt sha256 value. */
    promptSha256: string;
    /** The config sha256 value. */
    configSha256: string;
    /** The started at value. */
    startedAt: string;
    /** The argv value. */
    argv: string[];
    /** The env names value. */
    envNames: string[];
}

/** The completion record written after the container exits. */
export interface TrialMeta {
    /** The schema version value. */
    schemaVersion: 1;
    /** The campaign id value. */
    campaignId: string;
    /** The slot id value. */
    slotId: string;
    /** The case id value. */
    caseId: string;
    /** The arm id value. */
    armId: string;
    /** The repetition id value. */
    repetitionId: string;
    /** The exit value. */
    exit: number | null;
    /** The signal value. */
    signal: string | null;
    /** The timed out value. */
    timedOut: boolean;
    /** The error value. */
    error: string | null;
    /** Whether captured output exceeded its byte limit. */
    overflowed?: boolean;
    /** The duration ms value. */
    durationMs: number;
    /** The capture valid value. */
    captureValid: boolean;
    /** The capture problems value. */
    captureProblems: string[];
    /** The text parts value. */
    textParts: number;
    /** The last part kind value. */
    lastPartKind: string | null;
    /** The parse failures value. */
    parseFailures: number;
    /** The events value. */
    events: number;
    /** The prompt sha256 value. */
    promptSha256: string;
    /** The answer sha256 value. */
    answerSha256: string;
    /** The image id value. */
    imageId: string;
    /** The completed at value. */
    completedAt: string;
}

/** What one run invocation did. */
export interface RunSummary {
    /** The ok value. */
    ok: boolean;
    /** The ran value. */
    ran: string[];
    /** The refused value. */
    refused: string[];
    /** The problems value. */
    problems: string[];
}

/** Dependencies the runner accepts, so ordinary tests need no Podman. */
export interface RunDeps {
    /** The run container value. */
    runContainer?: (plan: ContainerPlan) => Promise<CommandResult>;
    /** The now value. */
    now?: () => string;
    /** The executing tool identity, injected for drift tests. */
    tool?: ToolIdentity;
}

/** Path of one trial's evidence directory. */
export function trialDirectory(root: string, slotId: string): string {
    return join(root, "evidence", "trials", slotId);
}

/** Find one schedule slot by id. */
function slotOf(campaign: Campaign, slotId: string): Slot | undefined {
    return campaign.schedule.slots.find((slot) => slot.slotId === slotId);
}

/** Find one staged arm by id. */
function armOf(
    manifest: PreparedManifest,
    armId: string,
): StagedArm | undefined {
    return manifest.subjects.find((arm) => arm.armId === armId);
}

/** A staged arm in the normalised campaign form. */
function campaignArm(campaign: Campaign, armId: string): Arm | undefined {
    return campaign.subjects.find((arm) => arm.armId === armId);
}

/** Copy the arm's instruction overlays into the workspace. */
function stageInstructions(
    root: string,
    arm: StagedArm,
    workspace: string,
): string[] {
    const problems: string[] = [];
    for (const instruction of arm.instructions) {
        const target = join(workspace, instruction.as);
        if (existsSync(target)) {
            problems.push(
                `instruction ${instruction.id} collides with ${instruction.as}`,
            );
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, "prepare", instruction.path), target);
    }
    return problems;
}

/** Copy the arm's skill bundles into the read-only config home. */
function stageSkills(
    root: string,
    arm: StagedArm,
    configHome: string,
): string[] {
    const problems: string[] = [];
    for (const skill of arm.skills) {
        const staged = stageTree(
            join(root, "prepare", skill.path),
            join(configHome, "opencode", "skills", skill.id),
        );
        if (!staged.ok) {
            problems.push(`skill ${skill.id}: ${staged.problem}`);
        }
    }
    return problems;
}

/** The mounts for one trial. */
function trialMounts(options: {
    workspace: string;
    configHome: string;
    subjects: string;
    journal: string | null;
}): Mount[] {
    const mounts: Mount[] = [
        {
            source: options.workspace,
            target: CONTAINER_WORKSPACE,
            readOnly: false,
        },
        {
            source: options.configHome,
            target: CONTAINER_CONFIG_HOME,
            readOnly: true,
        },
        {
            source: options.subjects,
            target: CONTAINER_SUBJECTS,
            readOnly: true,
        },
    ];
    if (options.journal !== null) {
        mounts.push({
            source: options.journal,
            target: CONTAINER_JOURNAL,
            readOnly: false,
        });
    }
    return normaliseMounts(mounts);
}

/** Write the 0600 trial environment file and return its names. */
function writeTrialEnvironment(
    trialDir: string,
    campaign: Campaign,
    journal: string | null,
    passthrough: readonly string[],
):
    | { ok: true; envFile: string; names: string[] }
    | { ok: false; problems: string[] } {
    const env = sessionEnv(process.env, {
        configHome: CONTAINER_CONFIG_HOME,
        dataHome: "/tmp/agent-home/.local/share",
        cacheHome: "/tmp/agent-home/.cache",
        overlay: providerOverlay(campaign),
        passthrough,
    });
    if (journal !== null) {
        env.DOCS_OPERATION_JOURNAL = `${CONTAINER_JOURNAL}/docs-operations.jsonl`;
        env.DOCS_OPERATION_JOURNAL_KEY = randomBytes(32).toString("hex");
        writeFileSync(
            join(trialDir, "journal-key.txt"),
            env.DOCS_OPERATION_JOURNAL_KEY,
            { encoding: "utf8", mode: 0o600 },
        );
    }
    const names = [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_CONFIG_CONTENT",
        ...(journal === null
            ? []
            : ["DOCS_OPERATION_JOURNAL", "DOCS_OPERATION_JOURNAL_KEY"]),
        ...passthrough,
    ];
    const problems = environmentFileProblems(env, names, passthrough);
    if (problems.length > 0) return { ok: false, problems };
    const envFile = join(trialDir, "trial.env");
    writeFileSync(envFile, environmentFileText(env, names), {
        encoding: "utf8",
        mode: 0o600,
    });
    return { ok: true, envFile, names };
}

/** Stage the workspace, config home and journal for one trial. */
function stageTrialPayload(
    root: string,
    campaign: Campaign,
    armValue: Arm,
    arm: StagedArm,
    testCase: SuiteCase,
    trialDir: string,
):
    | {
          ok: true;
          workspace: string;
          configHome: string;
          journal: string | null;
      }
    | { ok: false; problems: string[] } {
    mkdirSync(trialDir, { recursive: true });
    const workspace = join(trialDir, "workspace");
    const stagedWorkspace = stageTree(
        join(root, "prepare", "workspaces", testCase.caseId),
        workspace,
    );
    if (!stagedWorkspace.ok) {
        return { ok: false, problems: [stagedWorkspace.problem] };
    }
    const instructionProblems = stageInstructions(root, arm, workspace);
    if (instructionProblems.length > 0) {
        return { ok: false, problems: instructionProblems };
    }
    const configHome = writeConfigHome(trialDir, campaign, armValue);
    const skillProblems = stageSkills(root, arm, configHome);
    if (skillProblems.length > 0) {
        return { ok: false, problems: skillProblems };
    }
    const journal =
        testCase.kind === "docs-task" ? join(trialDir, "journal") : null;
    if (journal !== null) mkdirSync(journal, { recursive: true });
    return { ok: true, workspace, configHome, journal };
}

/**
 * Build the container plan for one trial without dispatching it. Dry runs and
 * tests use the same plan the real runner executes.
 * @param options The resolved trial inputs.
 * @returns The validated plan, or the problems found while staging.
 * @param options.root The root value.
 * @param options.manifest The manifest value.
 * @param options.frozen The frozen value.
 * @param options.slot The slot value.
 * @param options.testCase The testCase value.
 * @param options.arm The arm value.
 * @param options.trialDir The trialDir value.
 * @param options.passthrough The passthrough value.
 */
export function planTrial(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    testCase: SuiteCase;
    arm: StagedArm;
    trialDir: string;
    passthrough?: readonly string[];
}):
    | { ok: true; plan: ContainerPlan; argv: string[]; configSha256: string }
    | { ok: false; problems: string[] } {
    const { root, manifest, frozen, slot, testCase, arm, trialDir } = options;
    const campaign = manifest.campaign;
    const armValue = campaignArm(campaign, slot.armId);
    if (armValue === undefined) {
        return {
            ok: false,
            problems: [`arm ${slot.armId} is not in the manifest`],
        };
    }
    const payload = stageTrialPayload(
        root,
        campaign,
        armValue,
        arm,
        testCase,
        trialDir,
    );
    if (!payload.ok) return payload;
    const { workspace, configHome, journal } = payload;
    const configPath = join(configHome, "opencode", "opencode.json");
    const configSha256 = sha256Bytes(readFileSync(configPath));
    const prompt = readPrompt(root, testCase.caseId);
    if (prompt === null) {
        return {
            ok: false,
            problems: [`prompt for ${testCase.caseId} is missing`],
        };
    }
    const argv = [
        "opencode",
        ...opencodeRunArgs({
            model: campaign.runtime.provider.model,
            title: `otc-${campaign.campaignId}-${slot.slotId}`,
            prompt,
            printLogs: process.env.OTC_PRINT_LOGS === "1",
        }),
    ];
    const passthrough = [
        ...(campaign.runtime.passthroughEnv ?? []),
        ...(options.passthrough ?? []),
    ];
    const environment = writeTrialEnvironment(
        trialDir,
        campaign,
        journal,
        passthrough,
    );
    if (!environment.ok) return environment;
    const { envFile, names } = environment;
    const plan: ContainerPlan = {
        imageId: frozen.imageId,
        mounts: trialMounts({
            workspace,
            configHome,
            subjects: join(root, "prepare", "subjects", arm.armId),
            journal,
        }),
        workdir: CONTAINER_WORKSPACE,
        network: campaign.runtime.network,
        argv,
        envNames: [...new Set(names)],
        envFile,
        timeoutMs: campaign.runtime.timeoutMs,
        name: ownedContainerName(
            campaign.campaignId,
            slot.slotId,
            randomBytes(6).toString("hex"),
        ),
        labels: {
            "otc.owner": "otc",
            "otc.campaign": campaign.campaignId,
            "otc.slot": slot.slotId,
        },
    };
    return { ok: true, plan, argv, configSha256 };
}

/** Read one prepared prompt. */
function readPrompt(root: string, caseId: string): string | null {
    try {
        return readFileSync(
            join(root, "prepare", "prompts", `${caseId}.txt`),
            "utf8",
        );
    } catch {
        return null;
    }
}

/** Capture integrity problems from one completed container result. */
function captureIntegrity(
    result: CommandResult,
    trail: DecodedTrail,
): string[] {
    const integrity = captureProblems(trail);
    if (result.status !== 0) {
        integrity.push(`container exited ${String(result.status)}`);
    }
    if (result.timedOut) integrity.push("container timed out");
    if (result.error !== null) {
        integrity.push(`container error: ${result.error}`);
    }
    return integrity;
}

/**
 * Place the answer where a docs primary checker expects it, without ever
 * overwriting or following a subject-controlled destination.
 *
 * The canonical answer stays in host-owned trial evidence. This copy exists
 * only because the checker's contract reads `/workspace/answer.md`. Exclusive
 * creation means a subject-written answer survives untouched; an existing
 * symlink, FIFO or directory is reported as a problem rather than followed,
 * so the copy can never write outside the workspace.
 * @param workspace The trial workspace.
 * @param text The captured answer.
 * @returns Whether a copy was written, or the refusal.
 */
function placeWorkspaceAnswer(
    workspace: string,
    text: string,
): { ok: true; written: boolean } | { ok: false; problem: string } {
    const target = join(workspace, "answer.md");
    let fd: number;
    try {
        fd = openSync(
            target,
            constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
            0o600,
        );
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ELOOP") {
            // Occupied: keep what the subject wrote, but only when it is a
            // regular file. Classifying without following refuses a symlink,
            // FIFO, directory or escaping object explicitly.
            const entry = containedEntry(workspace, "answer.md");
            if (!entry.ok) {
                return {
                    ok: false,
                    problem: `workspace answer.md is unsafe: ${entry.problem}`,
                };
            }
            if (entry.kind === "file") return { ok: true, written: false };
            return {
                ok: false,
                problem: `workspace answer.md is a ${entry.kind}; refusing to replace it`,
            };
        }
        return {
            ok: false,
            problem: `workspace answer.md could not be created: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    try {
        writeFileSync(fd, text, "utf8");
    } finally {
        closeSync(fd);
    }
    return { ok: true, written: true };
}

/** Write all evidence for one completed trial. */
function writeTrialEvidence(
    trialDir: string,
    result: CommandResult,
    trail: DecodedTrail,
    meta: TrialMeta,
): void {
    writeFileSync(join(trialDir, "events.jsonl"), result.stdout, "utf8");
    writeFileSync(join(trialDir, "answer.md"), trail.text, "utf8");
    writeFileSync(
        join(trialDir, "tools.jsonl"),
        trail.calls.length === 0
            ? ""
            : `${trail.calls.map((call) => JSON.stringify(call)).join("\n")}\n`,
        "utf8",
    );
    writeFileSync(
        join(trialDir, "meta.json"),
        `${JSON.stringify(meta, null, 2)}\n`,
        "utf8",
    );
    writeFileSync(
        join(trialDir, "usage.json"),
        `${JSON.stringify(trail.usage, null, 2)}\n`,
        "utf8",
    );
    if (result.stderr !== "") {
        writeFileSync(join(trialDir, "stderr.txt"), result.stderr, "utf8");
    }
}

/** Execute one claimed trial and record its evidence. */
async function executeSlot(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    testCase: SuiteCase;
    planned: { plan: ContainerPlan; argv: string[]; configSha256: string };
    trialDir: string;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
    signal?: AbortSignal;
}): Promise<{
    meta: TrialMeta;
    primaryProblems: string[];
    primaryStatus: PrimaryCheckRecord["status"] | null;
}> {
    const { root, manifest, frozen, slot, planned, trialDir, execute, now } =
        options;
    const startedAt = now();
    const launch: LaunchReceipt = {
        schemaVersion: 1,
        campaignId: manifest.campaignId,
        slotId: slot.slotId,
        caseId: slot.caseId,
        armId: slot.armId,
        repetitionId: slot.repetitionId,
        imageId: frozen.imageId,
        promptSha256:
            manifest.cases.find((entry) => entry.caseId === slot.caseId)
                ?.promptSha256 ?? "unknown",
        configSha256: planned.configSha256,
        startedAt,
        argv: planned.argv,
        envNames: planned.plan.envNames,
    };
    writeFileSync(
        join(trialDir, "launch.json"),
        `${JSON.stringify(launch, null, 2)}\n`,
        "utf8",
    );
    appendLedgerEvent(
        root,
        {
            event: "trial-start",
            campaignId: manifest.campaignId,
            slotId: slot.slotId,
            trialId: slot.slotId,
            caseId: slot.caseId,
            armId: slot.armId,
            repetitionId: slot.repetitionId,
            imageId: frozen.imageId,
            promptSha256: launch.promptSha256,
        },
        startedAt,
    );
    const started = Date.now();
    let result: CommandResult;
    try {
        result = await execute(planned.plan);
    } finally {
        // The env file holds provider credentials; it must disappear on every
        // path, including a throwing runner.
        if (planned.plan.envFile !== null) {
            rmSync(planned.plan.envFile, { force: true });
        }
    }
    const completedAt = now();
    const trail = decodeTrail(result.stdout);
    const integrity = captureIntegrity(result, trail);
    if (options.testCase.kind === "docs-task") {
        const placed = placeWorkspaceAnswer(
            join(trialDir, "workspace"),
            trail.text,
        );
        if (!placed.ok) integrity.push(placed.problem);
    }
    const meta: TrialMeta = {
        schemaVersion: 1,
        campaignId: manifest.campaignId,
        slotId: slot.slotId,
        caseId: slot.caseId,
        armId: slot.armId,
        repetitionId: slot.repetitionId,
        exit: result.status,
        signal: result.signal,
        timedOut: result.timedOut,
        error: result.error,
        overflowed: result.overflowed === true,
        durationMs: Date.now() - started,
        captureValid: integrity.length === 0,
        captureProblems: integrity,
        textParts: trail.textParts,
        lastPartKind: trail.lastPartKind,
        parseFailures: trail.parseFailures,
        events: trail.events,
        promptSha256: launch.promptSha256,
        answerSha256: sha256Bytes(trail.text),
        imageId: frozen.imageId,
        completedAt,
    };
    writeTrialEvidence(trialDir, result, trail, meta);
    appendLedgerEvent(
        root,
        {
            event: "trial-end",
            campaignId: manifest.campaignId,
            slotId: slot.slotId,
            trialId: slot.slotId,
            captureValid: meta.captureValid,
            exit: meta.exit,
        },
        completedAt,
    );
    const primary = await primaryStage({
        root,
        manifest,
        frozen,
        slot,
        testCase: options.testCase,
        trialDir,
        execute,
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { meta, ...primary };
}

/** Run the declared primary checker, if this case has one. */
async function primaryStage(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    testCase: SuiteCase;
    trialDir: string;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
    signal?: AbortSignal;
}): Promise<{
    primaryProblems: string[];
    primaryStatus: PrimaryCheckRecord["status"] | null;
}> {
    const { root, manifest, frozen, slot, testCase, trialDir, execute, now } =
        options;
    const preparedCase = manifest.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (testCase.kind !== "docs-task" || testCase.primaryCheck === undefined) {
        return { primaryProblems: [], primaryStatus: null };
    }
    if (preparedCase === undefined) {
        return {
            primaryProblems: ["the case has no prepared primary checker"],
            primaryStatus: null,
        };
    }
    const checked = await executePrimaryCheck({
        root,
        testCase,
        prepared: preparedCase,
        trialDir,
        workspace: join(trialDir, "workspace"),
        imageId: frozen.imageId,
        run: (plan) => execute(plan),
        now,
        name: ownedContainerName(
            manifest.campaignId,
            `checker-${slot.slotId}`,
            randomBytes(6).toString("hex"),
        ),
        labels: {
            "otc.owner": "otc",
            "otc.campaign": manifest.campaignId,
            "otc.checker": slot.slotId,
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (checked.record !== null) {
        appendLedgerEvent(
            root,
            {
                event: "primary-check",
                campaignId: manifest.campaignId,
                slotId: slot.slotId,
                checkerId: checked.record.id,
                status: checked.record.status,
                exit: checked.record.exit,
                sourceHash: checked.record.sourceHash,
            },
            now(),
        );
    }
    return {
        primaryProblems: checked.problem === null ? [] : [checked.problem],
        primaryStatus: checked.record?.status ?? null,
    };
}

/** Throw for a slot selector that the prepared schedule does not contain. */
function refuseUnknownSelectors(
    root: string,
    slotIds: readonly string[] | undefined,
): void {
    if (slotIds === undefined) return;
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return;
    const known = new Set(
        prepared.manifest.campaign.schedule.slots.map((slot) => slot.slotId),
    );
    for (const slotId of slotIds) {
        if (!known.has(slotId)) throw new Error(`unknown slotId ${slotId}`);
    }
}

/** Resolve the selected slots, refusing an unknown selector. */
function selectedSlots(
    campaign: Campaign,
    slotIds: readonly string[] | undefined,
): Slot[] {
    if (slotIds === undefined) return campaign.schedule.slots;
    return slotIds.map((slotId) => {
        const found = slotOf(campaign, slotId);
        if (found === undefined) throw new Error(`unknown slotId ${slotId}`);
        return found;
    });
}

/** The capture problems a slot's meta records. */
function metaProblems(slotId: string, meta: TrialMeta): string[] {
    if (meta.captureValid) return [];
    return [
        `slot ${slotId} capture is invalid: ${meta.captureProblems.join("; ")}`,
    ];
}

/** The outcome of attempting one scheduled slot. */
interface SlotOutcome {
    ran: boolean;
    refused: boolean;
    problems: string[];
    stop: boolean;
}

/** Why a slot may not be dispatched now, or null. */
function slotPrecondition(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
    already: ReadonlySet<string>,
): SlotOutcome | null {
    if (already.has(slot.slotId)) {
        return {
            ran: false,
            refused: true,
            problems: [`slot ${slot.slotId} has already started`],
            stop: false,
        };
    }
    if (existsSync(trialDirectory(root, slot.slotId))) {
        return {
            ran: false,
            refused: true,
            problems: [
                `slot ${slot.slotId} has a trial directory without a matching ledger start`,
            ],
            stop: false,
        };
    }
    return null;
}

/** Attempt one slot: preconditions, planning, dispatch and evidence. */
async function dispatchSlot(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    already: ReadonlySet<string>;
    dryRun: boolean;
    passthrough: readonly string[] | undefined;
    signal: AbortSignal | undefined;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<SlotOutcome> {
    const { root, manifest, frozen, slot, already, dryRun, execute, now } =
        options;
    const precondition = slotPrecondition(root, manifest, slot, already);
    if (precondition !== null) return precondition;
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    const arm = armOf(manifest, slot.armId);
    if (testCase === undefined || arm === undefined) {
        return {
            ran: false,
            refused: false,
            problems: [`slot ${slot.slotId} has no staged case or arm`],
            stop: false,
        };
    }
    const trialDir = trialDirectory(root, slot.slotId);
    if (dryRun) {
        return dryRunPlan({ ...options, testCase, arm });
    }
    const claimed = claimTrial(root, manifest, slot);
    if (!claimed.ok) return claimed.outcome;
    const planned = planClaimed({
        ...options,
        testCase,
        arm,
        trialDir,
        claim: claimed.claim,
    });
    if (!planned.ok) return planned.outcome;
    if (options.signal !== undefined)
        planned.planned.plan.signal = options.signal;
    advanceClaim(claimed.claim, "spawned", {
        stamp: slot.slotId,
        note: "trial dispatch started",
    });
    const meta = await executeSlot({
        root,
        manifest,
        frozen,
        slot,
        testCase,
        planned: planned.planned,
        trialDir,
        execute,
        now,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    advanceClaim(claimed.claim, "closed", {
        note: "trial terminal evidence recorded",
    });
    return {
        ran: true,
        refused: false,
        problems: [
            ...metaProblems(slot.slotId, meta.meta),
            ...meta.primaryProblems,
        ],
        stop: runShouldStop(manifest.campaign, {
            captureValid: meta.meta.captureValid,
            exit: meta.meta.exit,
            primaryStatus: meta.primaryStatus,
        }),
    };
}

/** The slot inputs shared by planning helpers. */
interface SlotPlanning {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    testCase: SuiteCase;
    arm: StagedArm;
    passthrough: readonly string[] | undefined;
}

/** Plan a dry run in a disposable directory, then remove it. */
function dryRunPlan(options: SlotPlanning): SlotOutcome {
    const planDirectory = mkdtempSync(join(tmpdir(), "otc-plan-"));
    const planned = planTrial({
        root: options.root,
        manifest: options.manifest,
        frozen: options.frozen,
        slot: options.slot,
        testCase: options.testCase,
        arm: options.arm,
        trialDir: planDirectory,
        ...(options.passthrough === undefined
            ? {}
            : { passthrough: options.passthrough }),
    });
    rmSync(planDirectory, { recursive: true, force: true });
    return planned.ok
        ? { ran: true, refused: false, problems: [], stop: false }
        : {
              ran: false,
              refused: false,
              problems: planned.problems,
              stop: false,
          };
}

/** Claim one trial's slot key and budget index, or report the refusal. */
function claimTrial(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
): { ok: true; claim: BudgetClaim } | { ok: false; outcome: SlotOutcome } {
    const admitted = withAdmission(root, () => {
        const ledger = readLedger(root);
        if (ledger.state === "closed") return { state: "closed" } as const;
        if (ledger.state === "malformed") {
            return { state: "malformed", problems: ledger.problems } as const;
        }
        return {
            state: "open",
            claimed: claimBudget(
                join(root, "evidence"),
                "trial",
                manifest.campaign.budgets.trials,
                {
                    stamp: slot.slotId,
                    key: `slot:${slot.slotId}`,
                    note: "trial reservation",
                },
            ),
        } as const;
    });
    if (!admitted.ok) {
        return {
            ok: false,
            outcome: {
                ran: false,
                refused: false,
                problems: [admitted.problem],
                stop: true,
            },
        };
    }
    const value = admitted.value;
    if (value.state === "closed") {
        return {
            ok: false,
            outcome: {
                ran: false,
                refused: true,
                problems: [
                    "campaign is closed; no further dispatch is permitted",
                ],
                stop: true,
            },
        };
    }
    if (value.state === "malformed") {
        return {
            ok: false,
            outcome: {
                ran: false,
                refused: true,
                problems: [
                    `attempt ledger is malformed: ${value.problems.join("; ")}`,
                ],
                stop: true,
            },
        };
    }
    if (value.claimed.ok) return { ok: true, claim: value.claimed.claim };
    const logical = value.claimed.reason.includes("logical attempt");
    return {
        ok: false,
        outcome: {
            ran: false,
            refused: logical,
            problems: [value.claimed.reason],
            stop: !logical,
        },
    };
}

/** Stage a claimed trial; release only when nothing was dispatched. */
function planClaimed(
    options: SlotPlanning & { trialDir: string; claim: BudgetClaim },
):
    | {
          ok: true;
          planned: {
              plan: ContainerPlan;
              argv: string[];
              configSha256: string;
          };
      }
    | { ok: false; outcome: SlotOutcome } {
    let planned;
    try {
        planned = planTrial({
            root: options.root,
            manifest: options.manifest,
            frozen: options.frozen,
            slot: options.slot,
            testCase: options.testCase,
            arm: options.arm,
            trialDir: options.trialDir,
            ...(options.passthrough === undefined
                ? {}
                : { passthrough: options.passthrough }),
        });
    } catch (error) {
        // A throwing planner before dispatch leaves nothing worth keeping.
        rmSync(options.trialDir, { recursive: true, force: true });
        releaseClaim(options.claim);
        throw error;
    }
    if (planned.ok) return { ok: true, planned };
    // The claim provably never dispatched, so release it and remove only this
    // invocation's provisional trial tree. A corrected retry owns the path.
    releaseClaim(options.claim);
    rmSync(options.trialDir, { recursive: true, force: true });
    return {
        ok: false,
        outcome: {
            ran: false,
            refused: false,
            problems: planned.problems,
            stop: false,
        },
    };
}

/** The validated state a run needs, or the refusal. */
function runState(
    root: string,
    current?: ToolIdentity,
):
    | {
          ok: true;
          manifest: PreparedManifest;
          frozen: FrozenRecord;
          ledger: ReturnType<typeof readLedger>;
      }
    | { ok: false; problems: string[] } {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const frozen = loadFrozen(root);
    if (!frozen.ok) return { ok: false, problems: [frozen.problem] };
    const differences =
        current === undefined
            ? deliveryCheck(root)
            : deliveryCheck(root, current);
    if (differences.length > 0) {
        return {
            ok: false,
            problems: ["delivery check failed", ...differences],
        };
    }
    const ledger = readLedger(root);
    if (ledger.state === "malformed") {
        return {
            ok: false,
            problems: [
                `attempt ledger is malformed: ${ledger.problems.join("; ")}`,
            ],
        };
    }
    if (ledger.state === "closed") {
        return {
            ok: false,
            problems: ["campaign is closed; no further dispatch is permitted"],
        };
    }
    return {
        ok: true,
        manifest: prepared.manifest,
        frozen: frozen.record,
        ledger,
    };
}

/**
 * Execute one or more scheduled slots. A launch receipt and ledger event are
 * written before the container starts, so an interrupted dispatch remains
 * visibly claimed rather than looking blank.
 * @param root The frozen campaign root.
 * @param options Slot selection and dry-run choice.
 * @param options.slotIds The selected slots.
 * @param options.dryRun Plan without dispatch.
 * @param options.passthrough Named environment values to pass through.
 * @param options.signal Cancels an in-flight dispatch with bounded cleanup.
 * @param deps Injected process runner and clock.
 * @returns What ran and what was refused.
 */
export async function runCampaign(
    root: string,
    options: {
        slotIds?: readonly string[];
        dryRun?: boolean;
        passthrough?: readonly string[];
        signal?: AbortSignal;
    } = {},
    deps: RunDeps = {},
): Promise<RunSummary> {
    // Reject an unknown selector before any state-dependent refusal, so the
    // caller always gets an input error rather than a misleading operational
    // one, and nothing has been written.
    refuseUnknownSelectors(root, options.slotIds);
    const state = runState(root, deps.tool);
    if (!state.ok) {
        return { ok: false, ran: [], refused: [], problems: state.problems };
    }
    const manifest = state.manifest;
    const selected = selectedSlots(manifest.campaign, options.slotIds);
    const already = new Set(startedSlots(state.ledger.events));
    const now = deps.now ?? (() => new Date().toISOString());
    const execute = deps.runContainer ?? runContainer;
    const ran: string[] = [];
    const refused: string[] = [];
    const problems: string[] = [];
    for (const slot of selected) {
        const outcome = await dispatchSlot({
            root,
            manifest,
            frozen: state.frozen,
            slot,
            already,
            dryRun: options.dryRun === true,
            passthrough: options.passthrough,
            signal: options.signal,
            execute,
            now,
        });
        if (outcome.ran) ran.push(slot.slotId);
        if (outcome.refused) refused.push(slot.slotId);
        problems.push(...outcome.problems);
        if (outcome.stop) break;
    }
    return { ok: problems.length === 0, ran, refused, problems };
}

/** The canonical identity of a trial's immutable launch receipt. */
export function launchSha256(launch: LaunchReceipt): string {
    return sha256Of(launch);
}
