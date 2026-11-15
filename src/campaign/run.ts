import { randomBytes } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Bytes, sha256Of } from "../contracts/canonical.ts";
import type { Arm, Campaign, Slot, SuiteCase } from "../contracts/types.ts";
import {
    decodeTrail,
    captureProblems,
    type DecodedTrail,
} from "../adapters/opencode/events.ts";
import {
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
    runContainer,
    type ContainerPlan,
    type Mount,
} from "../adapters/podman/container.ts";
import type { CommandResult } from "../adapters/process.ts";
import { deliveryCheck, loadFrozen, type FrozenRecord } from "./freeze.ts";
import { stageTree } from "./inventory.ts";
import {
    appendLedgerEvent,
    readLedger,
    startedSlots,
    trialStarts,
} from "./ledger.ts";
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
): { envFile: string; names: string[] } {
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
    const envFile = join(trialDir, "trial.env");
    writeFileSync(
        envFile,
        `${names
            .filter((name) => env[name] !== undefined)
            .map((name) => `${name}=${env[name] ?? ""}`)
            .join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
    );
    return { envFile, names };
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
    const { envFile, names } = writeTrialEnvironment(
        trialDir,
        campaign,
        journal,
        passthrough,
    );
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
    planned: { plan: ContainerPlan; argv: string[]; configSha256: string };
    trialDir: string;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<TrialMeta> {
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
    const result = await execute(planned.plan);
    if (planned.plan.envFile !== null) {
        rmSync(planned.plan.envFile, { force: true });
    }
    const completedAt = now();
    const trail = decodeTrail(result.stdout);
    const integrity = captureIntegrity(result, trail);
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
    return meta;
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

/** Whether the campaign stops after this trial. */
function shouldStop(manifest: PreparedManifest, meta: TrialMeta): boolean {
    return (
        manifest.campaign.stopOnFirstFailure === true &&
        (!meta.captureValid || meta.exit !== 0)
    );
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
    if (
        trialStarts(readLedger(root).events).length >=
        manifest.campaign.budgets.trials
    ) {
        return {
            ran: false,
            refused: false,
            problems: [
                `trial budget exhausted (${manifest.campaign.budgets.trials}) before slot ${slot.slotId}`,
            ],
            stop: true,
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
    const planDirectory = dryRun
        ? mkdtempSync(join(tmpdir(), "otc-plan-"))
        : trialDir;
    const planned = planTrial({
        root,
        manifest,
        frozen,
        slot,
        testCase,
        arm,
        trialDir: planDirectory,
        ...(options.passthrough === undefined
            ? {}
            : { passthrough: options.passthrough }),
    });
    if (!planned.ok) {
        if (dryRun) rmSync(planDirectory, { recursive: true, force: true });
        return {
            ran: false,
            refused: false,
            problems: planned.problems,
            stop: false,
        };
    }
    if (dryRun) {
        rmSync(planDirectory, { recursive: true, force: true });
        return { ran: true, refused: false, problems: [], stop: false };
    }
    const meta = await executeSlot({
        root,
        manifest,
        frozen,
        slot,
        planned,
        trialDir,
        execute,
        now,
    });
    return {
        ran: true,
        refused: false,
        problems: metaProblems(slot.slotId, meta),
        stop: shouldStop(manifest, meta),
    };
}

/** The validated state a run needs, or the refusal. */
function runState(root: string):
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
    const differences = deliveryCheck(root);
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
 * @param deps Injected process runner and clock.
 * @returns What ran and what was refused.
 */
export async function runCampaign(
    root: string,
    options: {
        slotIds?: readonly string[];
        dryRun?: boolean;
        passthrough?: readonly string[];
    } = {},
    deps: RunDeps = {},
): Promise<RunSummary> {
    const state = runState(root);
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
