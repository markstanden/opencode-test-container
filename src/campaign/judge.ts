/**
 * Blind docs judging for a campaign.
 *
 * The judge receives the established arm-neutral packet built from checked
 * evidence only. It runs in a neutral container with no arm subjects, no
 * campaign manifest and no evidence root. A usable judgement is stored with
 * its attempt; a registered policy may recover exactly one complete
 * `json-syntax` failure from the same packet bytes. Every dispatch is claimed
 * against a durable budget before it starts.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes, sha256Of } from "../contracts/canonical.ts";
import type { ToolIdentity } from "../contracts/version.ts";
import type { Campaign, DocsTaskCase, Slot } from "../contracts/types.ts";
import { isRecord } from "../contracts/validate.ts";
import {
    environmentFileProblems,
    environmentFileText,
    opencodeRunArgs,
    providerOverlay,
    sessionEnv,
    writeJudgeConfigHome,
} from "../adapters/opencode/runtime.ts";
import {
    normaliseMounts,
    ownedContainerName,
    runContainer,
    type ContainerPlan,
} from "../adapters/podman/container.ts";
import type { CommandResult } from "../adapters/process.ts";
import { decodeTrail, type Usage } from "../adapters/opencode/events.ts";
import {
    claimBudget,
    advanceClaim,
    claimUsage,
    readClaims,
    releaseClaim,
    type BudgetClaim,
} from "./budget.ts";
import {
    claimRecoveryBudget,
    parseRecoveryPolicy,
    recoveryDecision,
    recoveryPolicySha256,
    selectionProblems,
    selectionRecordOf,
    type RecoveryPolicy,
    type SelectionAttempt,
    type SelectionRecord,
} from "../evaluators/docs/analysis/recovery.ts";
import {
    buildAcPrompt,
    documentationScore,
    judgeFailureClass,
    parseAcJudgement,
    validateAcJudgement,
    type DocState,
    type DocumentationOutcome,
    type JudgeFailureClass,
} from "../evaluators/docs/scoring.ts";
import { docChanges, type LakeDocument } from "../evaluators/docs/campaign.ts";
import { creditedOperationLines } from "../evaluators/docs/assess.ts";
import { claimAttemptDir } from "./evidence-guard.ts";
import { deliveryCheck, loadFrozen, type FrozenRecord } from "./freeze.ts";
import { changedInventoryPaths, inventory } from "./inventory.ts";
import {
    readContainedDocuments,
    readContainedFile,
} from "../evidence/containment.ts";
import { randomBytes } from "node:crypto";
import { appendLedgerEvent, readLedger } from "./ledger.ts";
import { isAdverseOutcome, judgeShouldStop } from "./stop-policy.ts";
import { withAdmission } from "./admission.ts";
import {
    loadPreparedManifest,
    type PreparedCase,
    type PreparedManifest,
} from "./prepare.ts";
import { readPrimaryCheck } from "./primary.ts";
import { trialDirectory } from "./run.ts";

/** The terminal state of one judge attempt. */
export type JudgeAttemptStatus = "judged" | "invalid-verdict" | "judge-error";

/** A judge attempt's recorded state, including an unfinished dispatch. */
export type JudgeMetaStatus = JudgeAttemptStatus | "started";

/** One immutable judge attempt record. */
export interface JudgeAttemptMeta {
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
    /** The attempt id value. */
    attemptId: string;
    /** The judge model route. */
    judgeModel: string;
    /** The packet sha256 value; every recovery attempt must match it. */
    packetSha256: string;
    /** The attempt status value. */
    judgementStatus: JudgeMetaStatus;
    /** The failure class, or null on a usable judgement. */
    failureClass: JudgeFailureClass | null;
    /** Whether the capture proves a complete final response. */
    complete: boolean;
    /** The started at value. */
    startedAt: string;
    /** The completed at value. */
    completedAt: string;
    /** The exit value. */
    exit: number | null;
    /** The timed out value. */
    timedOut: boolean;
    /** The capture problems value. */
    captureProblems: string[];
    /** The judgement sha256 value, or null. */
    judgementSha256: string | null;
}

/** One stored judgement. */
export interface StoredJudgement {
    /** The schema version value. */
    schemaVersion: 1;
    /** The slot id value. */
    slotId: string;
    /** The attempt id value. */
    attemptId: string;
    /** The judged value, when usable. */
    status: JudgeAttemptStatus;
    /** The documentation outcome, when usable. */
    documentationOutcome: DocumentationOutcome | null;
    /** The utility score, when usable. */
    utility: number | null;
    /** The judgement payload. */
    value: Record<string, unknown> | null;
    /** The problems, empty on a usable judgement. */
    problems: string[];
}

/** Everything one judge invocation did. */
export interface JudgeSummary {
    /** Whether every selected slot produced a usable judgement or was skipped. */
    ok: boolean;
    /** Slots with a usable judgement, including idempotent skips. */
    judged: string[];
    /** Slots skipped because a checked selection already existed. */
    skipped: string[];
    /** Slots that produced no usable judgement. */
    refused: string[];
    /** The problems value. */
    problems: string[];
}

/** Dependencies the judge accepts, so ordinary tests need no Podman. */
export interface JudgeDeps {
    /** The run container value. */
    runContainer?: (plan: ContainerPlan) => Promise<CommandResult>;
    /** The now value. */
    now?: () => string;
    /** The executing tool identity, injected for drift tests. */
    tool?: ToolIdentity;
}

/** The path of one slot's judgement evidence. */
export function judgeDirectory(root: string, slotId: string): string {
    return join(root, "evidence", "judgements", slotId);
}

/** The one canonical claims location: the campaign evidence root. */
export function claimsRoot(root: string): string {
    return join(root, "evidence");
}

/** One dispatch's durable claims: a judge claim, plus a recovery claim. */
interface DispatchClaims {
    judge: BudgetClaim;
    recovery?: BudgetClaim;
}

/** Release reservations that provably dispatched nothing. */
function releaseClaims(claims: DispatchClaims): void {
    releaseClaim(claims.judge);
    if (claims.recovery !== undefined) releaseClaim(claims.recovery);
}

/** The path of one slot's checked selection. */
export function selectionPath(root: string, slotId: string): string {
    return join(judgeDirectory(root, slotId), "selection.json");
}

/** The path of one slot's immutable packet. */
export function packetPath(root: string, slotId: string): string {
    return join(judgeDirectory(root, slotId), "packet.md");
}

/** One attempt's directory. */
function attemptDirectory(
    root: string,
    slotId: string,
    attemptId: string,
): string {
    return join(judgeDirectory(root, slotId), attemptId);
}

/** Read one JSON object, or null. */
function readObject(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** Readdir when a directory exists, otherwise an empty list. */
function namesOf(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => /^attempt-\d{3}$/.test(name))
        .sort();
}

/** The recorded attempts for one slot. */
interface RecordedAttempt {
    attemptId: string;
    meta: JudgeAttemptMeta;
    facts: SelectionAttempt;
}

/** Read every recorded attempt, refusing a started or unreadable one. */
function recordedAttempts(
    root: string,
    slotId: string,
): { attempts: RecordedAttempt[]; problems: string[] } {
    const problems: string[] = [];
    const attempts: RecordedAttempt[] = [];
    for (const attemptId of namesOf(judgeDirectory(root, slotId))) {
        const directory = attemptDirectory(root, slotId, attemptId);
        const value = readObject(join(directory, "meta.json"));
        if (value === null) {
            problems.push(`judge ${slotId}/${attemptId} has no readable meta`);
            continue;
        }
        const meta = value as unknown as JudgeAttemptMeta;
        if (
            meta.judgementStatus !== "judged" &&
            meta.judgementStatus !== "invalid-verdict" &&
            meta.judgementStatus !== "judge-error"
        ) {
            problems.push(
                `judge ${slotId}/${attemptId} has an unresolved status ${JSON.stringify(meta.judgementStatus)}`,
            );
            continue;
        }
        attempts.push({
            attemptId,
            meta,
            facts: {
                attemptId,
                judgementStatus: meta.judgementStatus,
                packetSha256: meta.packetSha256,
                failureClass: meta.failureClass,
                complete: meta.complete,
            },
        });
    }
    return { attempts, problems };
}

/** Read every Markdown document under one contained workspace lake. */
function lakeDocuments(
    workspace: string,
    lakeRoot: string,
): { ok: true; documents: LakeDocument[] } | { ok: false; problem: string } {
    const read = readContainedDocuments(workspace, lakeRoot, (name) =>
        name.endsWith(".md"),
    );
    if (!read.ok) return read;
    const prefix = lakeRoot === "" ? "" : `${lakeRoot}/`;
    return {
        ok: true,
        documents: read.documents.map((document) => ({
            path: document.path.slice(prefix.length),
            contents: document.contents,
        })),
    };
}

/** The changed, created and removed files between the pristine and live trees. */
function changedPaths(
    pristine: string,
    live: string,
): { ok: true; paths: string[] } | { ok: false; problems: string[] } {
    const before = inventory(pristine);
    const after = inventory(live);
    if (!before.ok || !after.ok) {
        return {
            ok: false,
            problems: [
                ...(before.ok ? [] : [`pristine workspace: ${before.problem}`]),
                ...(after.ok ? [] : [`live workspace: ${after.problem}`]),
            ],
        };
    }
    return {
        ok: true,
        paths: changedInventoryPaths(before.entries, after.entries, [
            "answer.md",
        ]),
    };
}

/** The text of one file, or an empty string. */
function textOf(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The primary evidence a judge sees. */
function primaryEvidence(trialDir: string): {
    status: string;
    exit: number | null;
    stdout: string;
    stderr: string;
} {
    const record = readPrimaryCheck(trialDir);
    return {
        status: record?.status ?? "missing",
        exit: record?.exit ?? null,
        stdout: (record?.stdout ?? "").slice(0, 8000),
        stderr: (record?.stderr ?? "").slice(0, 4000),
    };
}

/** The documentation mutation state for one slot. */
function docStateFor(
    root: string,
    slot: Slot,
    testCase: DocsTaskCase,
): { ok: true; state: DocState } | { ok: false; problems: string[] } {
    const lakeRoot = testCase.lakeRoot ?? "docs";
    const beforeDocs = lakeDocuments(
        join(root, "prepare", "workspaces", testCase.caseId),
        lakeRoot,
    );
    const afterDocs = lakeDocuments(
        join(trialDirectory(root, slot.slotId), "workspace"),
        lakeRoot,
    );
    if (!beforeDocs.ok) {
        return {
            ok: false,
            problems: [`pristine lake ${lakeRoot}: ${beforeDocs.problem}`],
        };
    }
    if (!afterDocs.ok) {
        return {
            ok: false,
            problems: [`live lake ${lakeRoot}: ${afterDocs.problem}`],
        };
    }
    const change = docChanges(beforeDocs.documents, afterDocs.documents);
    return {
        ok: true,
        state: {
            documentsChanged: change.documentsChanged,
            createdPaths: change.createdPaths,
            modifiedPaths: change.modifiedPaths,
        },
    };
}

/** The packet and mutation state for one slot. */
function buildPacket(options: {
    root: string;
    slot: Slot;
    testCase: DocsTaskCase;
}):
    | { ok: true; packet: string; state: DocState }
    | { ok: false; problems: string[] } {
    const { root, slot, testCase } = options;
    const trialDir = trialDirectory(root, slot.slotId);
    const lakeRoot = testCase.lakeRoot ?? "docs";
    const beforeDocs = lakeDocuments(
        join(root, "prepare", "workspaces", testCase.caseId),
        lakeRoot,
    );
    const afterDocs = lakeDocuments(join(trialDir, "workspace"), lakeRoot);
    if (!beforeDocs.ok) {
        return {
            ok: false,
            problems: [`pristine lake ${lakeRoot}: ${beforeDocs.problem}`],
        };
    }
    if (!afterDocs.ok) {
        return {
            ok: false,
            problems: [`live lake ${lakeRoot}: ${afterDocs.problem}`],
        };
    }
    const changed = changedPaths(
        join(root, "prepare", "workspaces", testCase.caseId),
        join(trialDir, "workspace"),
    );
    if (!changed.ok) return changed;
    const state = docStateFor(root, slot, testCase);
    if (!state.ok) return state;
    const answer = readContainedFile(trialDir, "answer.md");
    if (!answer.ok) {
        return { ok: false, problems: [`trial answer: ${answer.problem}`] };
    }
    const operations = creditedOperationLines(trialDir);
    const packet = buildAcPrompt({
        taskPrompt: textOf(
            join(root, "prepare", "prompts", `${testCase.caseId}.txt`),
        ),
        standingPermission: textOf(
            join(root, "prepare", "workspaces", testCase.caseId, "AGENTS.md"),
        ),
        scenarioTruth: testCase.truth ?? "",
        beforeDocs: beforeDocs.documents,
        afterDocs: afterDocs.documents,
        changedPaths: changed.paths,
        primary: primaryEvidence(trialDir),
        docsOperations: operations.lines,
        answer: answer.text,
    });
    return { ok: true, packet, state: state.state };
}

/** The judge's immutable packet, writing it once or refusing a change. */
function packetFor(
    root: string,
    slotId: string,
    built: string,
):
    | { ok: true; packet: string; sha256: string }
    | { ok: false; problem: string } {
    const path = packetPath(root, slotId);
    if (existsSync(path)) {
        const existing = readFileSync(path, "utf8");
        if (existing !== built) {
            return {
                ok: false,
                problem: `the judge packet for ${slotId} changed after it was frozen; use a fresh root`,
            };
        }
        return { ok: true, packet: existing, sha256: sha256Bytes(existing) };
    }
    mkdirSync(join(root, "evidence", "judgements", slotId), {
        recursive: true,
    });
    writeFileSync(path, built, "utf8");
    return { ok: true, packet: built, sha256: sha256Bytes(built) };
}

/** The judge work mounts: packet read-only, config read-only, work writable. */
function judgeMounts(options: {
    packet: string;
    configHome: string;
    work: string;
}): ContainerPlan["mounts"] {
    return normaliseMounts([
        { source: options.packet, target: "/judge/packet.md", readOnly: true },
        { source: options.configHome, target: "/config-home", readOnly: true },
        { source: options.work, target: "/judge/work", readOnly: false },
    ]);
}

/** Write the 0600 judge environment file. */
function writeJudgeEnvironment(
    attemptDir: string,
    campaign: Campaign,
):
    | { ok: true; envFile: string; names: string[] }
    | { ok: false; problems: string[] } {
    const env = sessionEnv(process.env, {
        configHome: "/config-home",
        dataHome: "/tmp/agent-home/.local/share",
        cacheHome: "/tmp/agent-home/.cache",
        overlay: providerOverlay(campaign),
        passthrough: campaign.runtime.passthroughEnv ?? [],
    });
    const names = [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        ...(campaign.runtime.provider.overlay === undefined
            ? []
            : ["OPENCODE_CONFIG_CONTENT"]),
        ...(campaign.runtime.passthroughEnv ?? []),
    ];
    const problems = environmentFileProblems(
        env,
        names,
        campaign.runtime.passthroughEnv ?? [],
    );
    if (problems.length > 0) return { ok: false, problems };
    const envFile = join(attemptDir, "judge.env");
    writeFileSync(envFile, environmentFileText(env, names), {
        encoding: "utf8",
        mode: 0o600,
    });
    return { ok: true, envFile, names };
}

/** The outcome of one judge dispatch, before storage. */
interface AttemptOutcome {
    status: JudgeAttemptStatus;
    failureClass: JudgeFailureClass | null;
    complete: boolean;
    captureProblems: string[];
    judgement: StoredJudgement["value"];
    problems: string[];
    usage: Usage;
}

/** The capture problems a judge stream shows. */
function judgeCapture(trail: ReturnType<typeof decodeTrail>): string[] {
    const problems: string[] = [];
    if (trail.events === 0) problems.push("the judge emitted no events");
    if (trail.parseFailures > 0) {
        problems.push(
            `${trail.parseFailures} judge event line(s) were not readable JSON`,
        );
    }
    if (trail.textParts === 0) {
        problems.push("the judge emitted no answer text");
    }
    if (trail.lastPartKind !== "text") {
        problems.push("the judge stream did not end on an answer");
    }
    return problems;
}

/** One attempt outcome, assembled once so each path stays small. */
function attemptOutcome(options: {
    status: JudgeAttemptStatus;
    failureClass: JudgeFailureClass | null;
    complete: boolean;
    captureProblems: string[];
    judgement: StoredJudgement["value"];
    problems: string[];
    usage: Usage;
}): AttemptOutcome {
    return options;
}

/** The transport or process failure outcome. */
function processOutcome(
    result: CommandResult,
    trail: ReturnType<typeof decodeTrail>,
    captureProblems: string[],
    complete: boolean,
): AttemptOutcome {
    return attemptOutcome({
        status: "judge-error",
        failureClass: "transport-or-process",
        complete,
        captureProblems: [
            ...captureProblems,
            `judge process not ok (exit ${String(result.status)}${result.timedOut ? ", timed out" : ""}${result.error === null ? "" : `, ${result.error}`})`,
        ],
        judgement: null,
        problems: [],
        usage: trail.usage,
    });
}

/** Classify a complete captured answer against its recorded mutation state. */
function verdictOutcome(
    trail: ReturnType<typeof decodeTrail>,
    state: DocState,
    captureProblems: string[],
): AttemptOutcome {
    const parsed = parseAcJudgement(trail.text);
    const complete = true;
    if (parsed.value === undefined) {
        return attemptOutcome({
            status: "invalid-verdict",
            failureClass: judgeFailureClass({
                complete,
                problems: parsed.problems,
            }),
            complete,
            captureProblems,
            judgement: null,
            problems: parsed.problems,
            usage: trail.usage,
        });
    }
    const problems = validateAcJudgement(parsed.value, state);
    return problems.length > 0
        ? attemptOutcome({
              status: "invalid-verdict",
              failureClass: judgeFailureClass({
                  complete,
                  value: parsed.value,
                  problems,
              }),
              complete,
              captureProblems,
              judgement: parsed.value,
              problems,
              usage: trail.usage,
          })
        : attemptOutcome({
              status: "judged",
              failureClass: null,
              complete,
              captureProblems,
              judgement: parsed.value,
              problems: [],
              usage: trail.usage,
          });
}

/** Classify one completed judge process. */
function classifyAttempt(
    result: CommandResult,
    state: DocState,
): AttemptOutcome {
    const trail = decodeTrail(result.stdout);
    const captureProblems = judgeCapture(trail);
    const complete = captureProblems.length === 0 && trail.text.trim() !== "";
    const processFailed =
        result.timedOut ||
        result.error !== null ||
        result.signal !== null ||
        result.status !== 0;
    if (processFailed) {
        return processOutcome(result, trail, captureProblems, complete);
    }
    return complete
        ? verdictOutcome(trail, state, captureProblems)
        : attemptOutcome({
              status: "judge-error",
              failureClass: "empty-or-truncated",
              complete: false,
              captureProblems,
              judgement: null,
              problems: [],
              usage: trail.usage,
          });
}

/** The planned dispatch for one attempt. */
interface AttemptPlan {
    ok: true;
    plan: ContainerPlan;
    attemptDir: string;
    packetSha256: string;
}

/** Build one attempt's dispatch plan without claiming or spawning. */
function planAttempt(options: {
    root: string;
    campaign: Campaign;
    slot: Slot;
    attemptId: string;
    packet: string;
    packetSha256: string;
    packetFile: string;
    judgeModel: string;
    attemptDirOverride?: string;
}): AttemptPlan | { ok: false; problems: string[] } {
    const attemptDir =
        options.attemptDirOverride ??
        attemptDirectory(options.root, options.slot.slotId, options.attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const configHome = writeJudgeConfigHome(
        attemptDir,
        options.campaign,
        options.judgeModel,
    );
    const work = join(attemptDir, "work");
    mkdirSync(work, { recursive: true });
    const environment = writeJudgeEnvironment(attemptDir, options.campaign);
    if (!environment.ok) return environment;
    const { envFile, names } = environment;
    const plan: ContainerPlan = {
        imageId: "",
        mounts: judgeMounts({
            packet: options.packetFile,
            configHome,
            work,
        }),
        workdir: "/judge/work",
        network: options.campaign.runtime.network,
        argv: [
            "opencode",
            ...opencodeRunArgs({
                model: options.judgeModel,
                // The session title is model-visible metadata: never encode a
                // slot, arm or attempt identity in it.
                title: `otc-judge-${sha256Bytes(options.attemptId).slice(0, 12)}`,
                prompt: options.packet,
                printLogs: process.env.OTC_PRINT_LOGS === "1",
            }),
        ],
        envNames: [...new Set(names)],
        envFile,
        timeoutMs:
            options.campaign.assessment.judge?.timeoutMs ??
            options.campaign.runtime.timeoutMs,
        name: ownedContainerName(
            options.campaign.campaignId,
            `judge-${options.slot.slotId}-${options.attemptId}`,
            randomBytes(6).toString("hex"),
        ),
        labels: {
            "otc.owner": "otc",
            "otc.judge": "1",
            "otc.campaign": options.campaign.campaignId,
            "otc.slot": options.slot.slotId,
            "otc.attempt": options.attemptId,
        },
    };
    return {
        ok: true,
        plan,
        attemptDir,
        packetSha256: options.packetSha256,
    };
}

/** Write one finished attempt's evidence. */
function storeAttempt(options: {
    attemptDir: string;
    meta: JudgeAttemptMeta;
    result: CommandResult;
    outcome: AttemptOutcome;
    usage: Usage;
}): void {
    writeFileSync(
        join(options.attemptDir, "output.jsonl"),
        options.result.stdout,
        "utf8",
    );
    writeFileSync(
        join(options.attemptDir, "usage.json"),
        `${JSON.stringify(options.usage, null, 2)}\n`,
        "utf8",
    );
    const judgement: StoredJudgement = {
        schemaVersion: 1,
        slotId: options.meta.slotId,
        attemptId: options.meta.attemptId,
        status: options.outcome.status,
        documentationOutcome:
            options.outcome.status === "judged" &&
            typeof options.outcome.judgement?.documentationOutcome === "string"
                ? (options.outcome.judgement
                      .documentationOutcome as DocumentationOutcome)
                : null,
        utility:
            options.outcome.status === "judged" &&
            typeof options.outcome.judgement?.documentationOutcome === "string"
                ? documentationScore(
                      options.outcome.judgement
                          .documentationOutcome as DocumentationOutcome,
                  )
                : null,
        value: options.outcome.judgement,
        problems: options.outcome.problems,
    };
    writeFileSync(
        join(options.attemptDir, "judgement.json"),
        `${JSON.stringify(judgement, null, 2)}\n`,
        "utf8",
    );
    writeFileSync(
        join(options.attemptDir, "meta.json"),
        `${JSON.stringify(
            {
                ...options.meta,
                judgementSha256: sha256Of(judgement),
            },
            null,
            2,
        )}\n`,
        "utf8",
    );
}

/** Write the per-slot selection after a usable judgement lands. */
function storeSelection(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    attempts: RecordedAttempt[];
    selectedAttemptId: string;
    policy: RecoveryPolicy | null;
}):
    | { ok: true; selection: SelectionRecord }
    | { ok: false; problems: string[] } {
    const index =
        options.manifest.campaign.schedule.slots.findIndex(
            (entry) => entry.slotId === options.slot.slotId,
        ) + 1;
    const selection = selectionRecordOf({
        slot: index,
        pairId: options.slot.repetitionId,
        stamp: options.slot.slotId,
        arm: options.slot.armId,
        scenario: options.slot.caseId,
        selectedAttemptId: options.selectedAttemptId,
        policySha256:
            options.policy === null
                ? null
                : recoveryPolicySha256(options.policy),
        attempts: options.attempts.map((entry) => entry.facts),
    });
    const problems = selectionProblems(selection, {
        slot: index,
        pairId: options.slot.repetitionId,
        stamp: options.slot.slotId,
        arm: options.slot.armId,
        scenario: options.slot.caseId,
        attemptIds: options.attempts.map((entry) => entry.attemptId),
        manifestAttemptId: null,
        policy: options.policy,
        attemptFacts: Object.fromEntries(
            options.attempts.map((entry) => [entry.attemptId, entry.facts]),
        ),
    });
    if (problems.length > 0) return { ok: false, problems };
    const path = selectionPath(options.root, options.slot.slotId);
    const existing = readObject(path);
    if (existing !== null && sha256Of(existing) !== sha256Of(selection)) {
        return {
            ok: false,
            problems: [
                `selection for ${options.slot.slotId} already holds different bytes; historical selections are immutable`,
            ],
        };
    }
    if (existing === null) {
        writeFileSync(path, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
    }
    return { ok: true, selection };
}

/** The registered recovery policy, or a parse refusal. */
export function policyOf(
    manifest: PreparedManifest,
):
    | { ok: true; policy: RecoveryPolicy | null }
    | { ok: false; problems: string[] } {
    const declared = manifest.campaign.assessment.recovery;
    if (declared === undefined) return { ok: true, policy: null };
    const parsed = parseRecoveryPolicy(declared);
    return parsed.ok
        ? { ok: true, policy: parsed.policy }
        : { ok: false, problems: parsed.problems };
}

/** The validated state a judge run needs, or the refusal. */
function judgeState(
    root: string,
    current?: ToolIdentity,
):
    | {
          ok: true;
          manifest: PreparedManifest;
          frozen: FrozenRecord;
          policy: RecoveryPolicy | null;
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
            problems: [
                "campaign is closed; no further judge dispatch is permitted",
            ],
        };
    }
    const policy = policyOf(prepared.manifest);
    if (!policy.ok) return { ok: false, problems: policy.problems };
    return {
        ok: true,
        manifest: prepared.manifest,
        frozen: frozen.record,
        policy: policy.policy,
    };
}

/** The judge budget ceiling that also respects the campaign's declared spend. */
function judgeCeiling(
    manifest: PreparedManifest,
    policy: RecoveryPolicy | null,
): number {
    const campaign = manifest.campaign.budgets.judgeAttempts;
    return policy === null
        ? campaign
        : Math.min(campaign, policy.totalJudgeAttempts);
}

/** Claim one initial judge dispatch. */
function claimInitial(
    root: string,
    ceiling: number,
    slot: Slot,
    attemptId: string,
    now: () => string,
): { ok: true; claim: BudgetClaim } | { ok: false; problem: string } {
    if (ceiling <= 0) {
        return {
            ok: false,
            problem: `judge budget is zero for ${slot.slotId}`,
        };
    }
    const admitted = withAdmission(root, () => {
        const ledger = readLedger(root);
        if (ledger.state === "closed") {
            return { kind: "closed" as const };
        }
        if (ledger.state === "malformed") {
            return { kind: "malformed" as const, problems: ledger.problems };
        }
        return {
            kind: "claim" as const,
            claimed: claimBudget(claimsRoot(root), "judge", ceiling, {
                stamp: slot.slotId,
                attemptId,
                key: `${slot.slotId}/${attemptId}`,
                at: now(),
            }),
        };
    });
    if (!admitted.ok) return { ok: false, problem: admitted.problem };
    if (admitted.value.kind === "closed") {
        return {
            ok: false,
            problem:
                "campaign is closed; no further judge dispatch is permitted",
        };
    }
    if (admitted.value.kind === "malformed") {
        return {
            ok: false,
            problem: `attempt ledger is malformed: ${admitted.value.problems.join("; ")}`,
        };
    }
    return admitted.value.claimed.ok
        ? { ok: true, claim: admitted.value.claimed.claim }
        : {
              ok: false,
              problem: `judge budget refused: ${admitted.value.claimed.reason}`,
          };
}

/** Dispatch one attempt and record its evidence. */
async function dispatchAttempt(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    caseId: string;
    attemptId: string;
    packet: string;
    packetSha256: string;
    judgeModel: string;
    state: DocState;
    claims: DispatchClaims;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<
    { ok: true; attempt: RecordedAttempt } | { ok: false; problem: string }
> {
    const attemptDir = attemptDirectory(
        options.root,
        options.slot.slotId,
        options.attemptId,
    );
    mkdirSync(judgeDirectory(options.root, options.slot.slotId), {
        recursive: true,
    });
    const claimDir = claimAttemptDir(attemptDir);
    if (!claimDir.ok) {
        releaseClaims(options.claims);
        return {
            ok: false,
            problem: `refusing to overwrite judge attempt ${options.attemptId}: ${claimDir.reason}`,
        };
    }
    let planned: ReturnType<typeof planAttempt>;
    try {
        planned = planAttempt({
            root: options.root,
            campaign: options.manifest.campaign,
            slot: options.slot,
            attemptId: options.attemptId,
            packet: options.packet,
            packetSha256: options.packetSha256,
            packetFile: packetPath(options.root, options.slot.slotId),
            judgeModel: options.judgeModel,
        });
    } catch (error) {
        releaseClaims(options.claims);
        rmSync(attemptDir, { recursive: true, force: true });
        throw error;
    }
    if (!planned.ok) {
        releaseClaims(options.claims);
        // Nothing was dispatched. Remove only this invocation's provisional
        // attempt directory so a corrected retry can claim the same identity.
        rmSync(attemptDir, { recursive: true, force: true });
        return {
            ok: false,
            problem: `judge environment is not valid: ${planned.problems.join("; ")}`,
        };
    }
    planned.plan.imageId = options.frozen.imageId;
    const startedAt = options.now();
    const startedMeta: JudgeAttemptMeta = {
        schemaVersion: 1,
        campaignId: options.manifest.campaignId,
        slotId: options.slot.slotId,
        caseId: options.slot.caseId,
        armId: options.slot.armId,
        attemptId: options.attemptId,
        judgeModel: options.judgeModel,
        packetSha256: options.packetSha256,
        judgementStatus: "started",
        failureClass: null,
        complete: false,
        startedAt,
        completedAt: "",
        exit: null,
        timedOut: false,
        captureProblems: ["judge dispatch started but has no terminal record"],
        judgementSha256: null,
    };
    writeFileSync(
        join(planned.attemptDir, "meta.json"),
        `${JSON.stringify(startedMeta, null, 2)}\n`,
        "utf8",
    );
    writeFileSync(
        join(planned.attemptDir, "packet.md"),
        options.packet,
        "utf8",
    );
    const spawned = {
        judge: advanceClaim(options.claims.judge, "spawned", {
            stamp: options.slot.slotId,
            attemptId: options.attemptId,
            note: "judge dispatch started",
        }),
        ...(options.claims.recovery === undefined
            ? {}
            : {
                  recovery: advanceClaim(options.claims.recovery, "spawned", {
                      stamp: options.slot.slotId,
                      attemptId: options.attemptId,
                      note: "recovery dispatch started",
                  }),
              }),
    };
    let result: CommandResult;
    try {
        result = await options.execute(planned.plan);
    } finally {
        if (planned.plan.envFile !== null) {
            rmSync(planned.plan.envFile, { force: true });
        }
    }
    const outcome = classifyAttempt(result, options.state);
    const completedAt = options.now();
    const meta: JudgeAttemptMeta = {
        ...startedMeta,
        judgementStatus: outcome.status,
        failureClass: outcome.failureClass,
        complete: outcome.complete,
        completedAt,
        exit: result.status,
        timedOut: result.timedOut,
        captureProblems: outcome.captureProblems,
    };
    storeAttempt({
        attemptDir: planned.attemptDir,
        meta,
        result,
        outcome,
        usage: outcome.usage,
    });
    advanceClaim(spawned.judge, "closed", {
        note: outcome.status,
        stamp: options.slot.slotId,
        attemptId: options.attemptId,
    });
    if (spawned.recovery !== undefined) {
        advanceClaim(spawned.recovery, "closed", {
            note: outcome.status,
            stamp: options.slot.slotId,
            attemptId: options.attemptId,
        });
    }
    appendLedgerEvent(
        options.root,
        {
            event: "judge-attempt",
            campaignId: options.manifest.campaignId,
            slotId: options.slot.slotId,
            attemptId: options.attemptId,
            judgementStatus: outcome.status,
            failureClass: outcome.failureClass,
            packetSha256: options.packetSha256,
            complete: outcome.complete,
            exit: result.status,
        },
        completedAt,
    );
    return {
        ok: true,
        attempt: {
            attemptId: options.attemptId,
            meta,
            facts: {
                attemptId: options.attemptId,
                judgementStatus: outcome.status,
                packetSha256: options.packetSha256,
                failureClass: outcome.failureClass,
                complete: outcome.complete,
            },
        },
    };
}

/** Resolve one slot's case, prepared payload and judge model. */
function resolveCase(
    manifest: PreparedManifest,
    slot: Slot,
):
    | { testCase: DocsTaskCase; prepared: PreparedCase; judgeModel: string }
    | { problem: string } {
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    const prepared = manifest.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (testCase === undefined || prepared === undefined) {
        return { problem: `slot ${slot.slotId} has no staged case` };
    }
    if (testCase.kind !== "docs-task") {
        return {
            problem: `slot ${slot.slotId} is ${testCase.kind}; only docs-task cases are judged`,
        };
    }
    const judge = manifest.campaign.assessment.judge;
    return judge === undefined
        ? { problem: "campaign declares no judge model" }
        : { testCase, prepared, judgeModel: judge.model };
}

/** Record a checked selection and its ledger event. */
function recordSelection(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    attempts: RecordedAttempt[];
    selectedAttemptId: string;
    policy: RecoveryPolicy | null;
    now: () => string;
}): { ok: true } | { ok: false; problems: string[] } {
    const stored = storeSelection(options);
    if (!stored.ok) return stored;
    appendLedgerEvent(
        options.root,
        {
            event: "judge-selection",
            campaignId: options.manifest.campaignId,
            slotId: options.slot.slotId,
            selectedAttemptId: options.selectedAttemptId,
            selectionSha256: sha256Of(stored.selection),
        },
        options.now(),
    );
    return { ok: true };
}

/** One checked per-slot selection and the evidence it names. */
export interface CheckedSelection {
    /** The checked selection record. */
    selection: SelectionRecord;
    /** The selected attempt's metadata. */
    meta: JudgeAttemptMeta;
    /** The selected attempt's stored judgement. */
    judgement: StoredJudgement;
}

/** Read a file's bytes, or null when it is absent or unreadable. */
function packetBytes(path: string): Buffer | null {
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path);
    } catch {
        return null;
    }
}

/** The registered packet identity against the actual slot and attempt bytes. */
function packetBindingProblems(
    root: string,
    slotId: string,
    attempt: RecordedAttempt,
): string[] {
    const problems: string[] = [];
    const slotPath = packetPath(root, slotId);
    const attemptPath = join(
        attemptDirectory(root, slotId, attempt.attemptId),
        "packet.md",
    );
    const slot = packetBytes(slotPath);
    const attemptBytes = packetBytes(attemptPath);
    if (slot === null)
        problems.push(`slot packet ${slotPath} is missing or unreadable`);
    if (attemptBytes === null) {
        problems.push(
            `attempt ${attempt.attemptId} packet ${attemptPath} is missing or unreadable`,
        );
    }
    if (slot !== null && sha256Bytes(slot) !== attempt.meta.packetSha256) {
        problems.push(
            `slot packet for ${slotId} does not match its registered identity`,
        );
    }
    if (
        attemptBytes !== null &&
        sha256Bytes(attemptBytes) !== attempt.meta.packetSha256
    ) {
        problems.push(
            `attempt ${attempt.attemptId} packet does not match its registered identity`,
        );
    }
    if (
        slot !== null &&
        attemptBytes !== null &&
        sha256Bytes(slot) !== sha256Bytes(attemptBytes)
    ) {
        problems.push(`slot and attempt packets for ${slotId} differ`);
    }
    return problems;
}

/**
 * Re-derive the packet evidence for one slot: every recorded attempt's packet
 * must hash to its registered identity, the slot and attempt copies must agree,
 * and every copy must equal the packet reconstructed from current evidence.
 * @param root The campaign root.
 * @param manifest The prepared manifest.
 * @param slot The scheduled slot.
 * @returns Packet integrity problems; empty means the packet is bound.
 */
export function packetIntegrityProblems(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
): string[] {
    const recorded = recordedAttempts(root, slot.slotId);
    if (recorded.attempts.length === 0) return recorded.problems;
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    const problems = [...recorded.problems];
    let expected: string | null = null;
    if (testCase?.kind === "docs-task") {
        const built = buildPacket({ root, slot, testCase });
        if (built.ok) expected = built.packet;
        else problems.push(...built.problems);
    }
    for (const attempt of recorded.attempts) {
        problems.push(...packetBindingProblems(root, slot.slotId, attempt));
        const attemptBytes = packetBytes(
            join(
                attemptDirectory(root, slot.slotId, attempt.attemptId),
                "packet.md",
            ),
        );
        if (
            expected !== null &&
            attemptBytes !== null &&
            attemptBytes.toString("utf8") !== expected
        ) {
            problems.push(
                `attempt ${attempt.attemptId} packet does not match current evidence`,
            );
        }
    }
    return problems;
}

/** The identity and attempt-set checks for one raw selection. */
function selectionRecordProblems(
    root: string,
    manifest: PreparedManifest,
    slot: Slot,
    policy: RecoveryPolicy | null,
): {
    problems: string[];
    selection: SelectionRecord | null;
    attempts: RecordedAttempt[];
} {
    const problems: string[] = [];
    const recorded = recordedAttempts(root, slot.slotId);
    problems.push(...recorded.problems);
    const raw = readObject(selectionPath(root, slot.slotId));
    if (raw === null) {
        return {
            problems: [
                ...problems,
                `selection for ${slot.slotId} is missing or unreadable`,
            ],
            selection: null,
            attempts: recorded.attempts,
        };
    }
    problems.push(
        ...selectionProblems(raw, {
            stamp: slot.slotId,
            arm: slot.armId,
            scenario: slot.caseId,
            attemptIds: recorded.attempts.map((entry) => entry.attemptId),
            manifestAttemptId: null,
            policy,
            attemptFacts: Object.fromEntries(
                recorded.attempts.map((entry) => [
                    entry.attemptId,
                    entry.facts,
                ]),
            ),
        }),
    );
    const selection = raw as unknown as SelectionRecord;
    const policyHash = policy === null ? null : recoveryPolicySha256(policy);
    if (selection.policySha256 !== policyHash) {
        problems.push(
            "selection policySha256 does not match the registered policy",
        );
    }
    const packets = new Set(
        recorded.attempts.map((entry) => entry.facts.packetSha256),
    );
    if (packets.size > 1) {
        problems.push("selection attempts were judged from different packets");
    }
    return { problems, selection, attempts: recorded.attempts };
}

/** The selected attempt, or the reason it is absent. */
function selectedAttempt(
    attempts: RecordedAttempt[],
    selection: SelectionRecord,
): { problems: string[]; selected: RecordedAttempt | null } {
    const selected = attempts.find(
        (entry) => entry.attemptId === selection.selectedAttemptId,
    );
    return selected === undefined
        ? {
              problems: [
                  `selection names an absent attempt ${String(selection.selectedAttemptId)}`,
              ],
              selected: null,
          }
        : { problems: [], selected };
}

/** The stored judgement's identity, hash and outcome shape. */
function judgementShapeProblems(
    judgement: Record<string, unknown>,
    slot: Slot,
    attemptId: string,
): string[] {
    if (
        judgement.status !== "judged" ||
        judgement.slotId !== slot.slotId ||
        judgement.attemptId !== attemptId ||
        !isRecord(judgement.value)
    ) {
        return [`selection ${attemptId} does not hold a usable judgement`];
    }
    return [];
}

/** The selected attempt and its stored judgement checks. */
function judgementRecordProblems(
    root: string,
    slot: Slot,
    testCase: DocsTaskCase,
    attempts: RecordedAttempt[],
    selection: SelectionRecord,
): {
    problems: string[];
    meta: JudgeAttemptMeta | null;
    judgement: StoredJudgement | null;
} {
    const chosen = selectedAttempt(attempts, selection);
    if (chosen.selected === null) {
        return {
            problems: chosen.problems,
            meta: null,
            judgement: null,
        };
    }
    const selected = chosen.selected;
    const problems =
        selected.meta.judgementStatus === "judged"
            ? []
            : [`selection names an unusable attempt ${selected.attemptId}`];
    const judgement = readObject(
        join(
            attemptDirectory(root, slot.slotId, selected.attemptId),
            "judgement.json",
        ),
    );
    if (judgement === null) {
        return {
            problems: [
                ...problems,
                `selection ${selected.attemptId} has no readable judgement`,
            ],
            meta: selected.meta,
            judgement: null,
        };
    }
    const shape = judgementShapeProblems(judgement, slot, selected.attemptId);
    if (shape.length > 0) {
        return {
            problems: [...problems, ...shape],
            meta: selected.meta,
            judgement: null,
        };
    }
    if (
        typeof selected.meta.judgementSha256 !== "string" ||
        selected.meta.judgementSha256 !== sha256Of(judgement)
    ) {
        problems.push(
            `selection ${selected.attemptId} judgement bytes changed`,
        );
    }
    const value = judgement.value as Record<string, unknown>;
    const outcome = value.documentationOutcome;
    if (
        typeof outcome !== "string" ||
        judgement.utility !==
            documentationScore(outcome as DocumentationOutcome)
    ) {
        problems.push(
            `selection ${selected.attemptId} has an inconsistent outcome`,
        );
    }
    const state = docStateFor(root, slot, testCase);
    if (state.ok) {
        problems.push(...validateAcJudgement(value, state.state));
    } else {
        problems.push(...state.problems);
    }
    return {
        problems,
        meta: selected.meta,
        judgement: judgement as unknown as StoredJudgement,
    };
}

/**
 * Re-derive one slot's selection from evidence. A readable object is not a
 * selection: attempt identity, packet identity, the selected judgement's hash,
 * its outcome/utility and its agreement with the documented mutation state are
 * all checked before status, closure, reporting or the judge trust it.
 * @param options The campaign root, manifest, slot and registered policy.
 * @returns The checked selection, or every inconsistency found.
 * @param options.root The campaign root.
 * @param options.manifest The prepared manifest.
 * @param options.slot The scheduled slot.
 * @param options.policy The parsed recovery policy, or null.
 */
export function checkedSelection(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    policy: RecoveryPolicy | null;
}): { ok: true; value: CheckedSelection } | { ok: false; problems: string[] } {
    const { root, manifest, slot, policy } = options;
    const testCase = manifest.suite.cases.find(
        (entry) => entry.caseId === slot.caseId,
    );
    if (testCase === undefined || testCase.kind !== "docs-task") {
        return {
            ok: false,
            problems: [`slot ${slot.slotId} has no docs case`],
        };
    }
    const packetProblems = packetIntegrityProblems(root, manifest, slot);
    const base = selectionRecordProblems(root, manifest, slot, policy);
    base.problems.unshift(...packetProblems);
    if (base.selection === null) {
        return { ok: false, problems: base.problems };
    }
    const judgement = judgementRecordProblems(
        root,
        slot,
        testCase,
        base.attempts,
        base.selection,
    );
    const problems = [...base.problems, ...judgement.problems];
    return problems.length > 0 ||
        judgement.meta === null ||
        judgement.judgement === null
        ? { ok: false, problems }
        : {
              ok: true,
              value: {
                  selection: base.selection,
                  meta: judgement.meta,
                  judgement: judgement.judgement,
              },
          };
}

/**
 * Load the manifest and policy, then check one slot's selection.
 * @param root The campaign root.
 * @param slotId The scheduled slot.
 * @returns The checked selection, or every inconsistency.
 */
export function checkedSelectionForSlot(
    root: string,
    slotId: string,
): { ok: true; value: CheckedSelection } | { ok: false; problems: string[] } {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const slot = prepared.manifest.campaign.schedule.slots.find(
        (entry) => entry.slotId === slotId,
    );
    if (slot === undefined) {
        return { ok: false, problems: [`unknown slotId ${slotId}`] };
    }
    const policy = policyOf(prepared.manifest);
    if (!policy.ok) return { ok: false, problems: policy.problems };
    return checkedSelection({
        root,
        manifest: prepared.manifest,
        slot,
        policy: policy.policy,
    });
}

/**
 * Build the exact judge packet for one slot without dispatching.
 * @param root The campaign root.
 * @param slotId The scheduled slot.
 * @returns The packet and mutation state, or the refusal.
 */
export function buildJudgePacketForSlot(
    root: string,
    slotId: string,
):
    | { ok: true; packet: string; state: DocState }
    | { ok: false; problems: string[] } {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const slot = prepared.manifest.campaign.schedule.slots.find(
        (entry) => entry.slotId === slotId,
    );
    const testCase = prepared.manifest.suite.cases.find(
        (entry) => entry.caseId === slot?.caseId,
    );
    const preparedCase = prepared.manifest.cases.find(
        (entry) => entry.caseId === slot?.caseId,
    );
    if (
        slot === undefined ||
        testCase?.kind !== "docs-task" ||
        preparedCase === undefined
    ) {
        return { ok: false, problems: [`slot ${slotId} has no docs case`] };
    }
    return buildPacket({ root, slot, testCase });
}

/** Settle a slot that already has a selection or a usable judgement. */
function settleExisting(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    attempts: RecordedAttempt[];
    policy: RecoveryPolicy | null;
    dryRun: boolean;
    now: () => string;
}): { status: "judged" | "skipped" | "refused"; problems: string[] } | null {
    const { root, slot, attempts, policy } = options;
    if (existsSync(selectionPath(root, slot.slotId))) {
        const checked = checkedSelection({
            root,
            manifest: options.manifest,
            slot,
            policy,
        });
        return checked.ok
            ? { status: "skipped", problems: [] }
            : { status: "refused", problems: checked.problems };
    }
    const judged = attempts.filter(
        (entry) => entry.meta.judgementStatus === "judged",
    );
    if (judged.length === 0) return null;
    if (options.dryRun) return { status: "judged", problems: [] };
    const recorded = recordSelection({
        ...options,
        selectedAttemptId: (judged[0] as RecordedAttempt).attemptId,
    });
    return recorded.ok
        ? { status: "judged", problems: [] }
        : { status: "refused", problems: recorded.problems };
}

/** Escape one identifier for a literal regular expression. */
function literal(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Experiment identifiers that must not appear in a judge packet, derived from
 * the declared campaign rather than historical arm letters or fixture words.
 * @param packet The rendered packet.
 * @param manifest The prepared manifest.
 * @param root The campaign root.
 * @returns Problems; empty means the packet is ar-blind.
 */
function campaignLeaks(
    packet: string,
    manifest: PreparedManifest,
    root: string,
): string[] {
    const campaign = manifest.campaign;
    const identifiers = [
        campaign.campaignId,
        ...campaign.subjects.map((arm) => arm.armId),
        ...campaign.schedule.slots.map((slot) => slot.slotId),
        ...manifest.suite.cases.map((testCase) => testCase.caseId),
    ];
    const problems = identifiers.flatMap((identifier) => {
        if (identifier === "") return [];
        const escaped = literal(identifier);
        // A distinctive identifier (with a digit or hyphen) is a leak wherever
        // it appears as a token. A plain-word identifier is only a leak in a
        // structural position (path segment, quoted value, assignment), so
        // legitimate task prose such as "the candidate must" is preserved.
        const pattern = /[0-9-]/.test(identifier)
            ? new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i")
            : new RegExp(
                  `(?:[/\\\\]${escaped}(?:[/\\\\]|$)|"${escaped}"|${escaped}=)`,
              );
        return pattern.test(packet)
            ? [`the packet names campaign identifier ${identifier}`]
            : [];
    });
    if (packet.includes(root))
        problems.push("the packet names the evidence root");
    return [...new Set(problems)];
}

/** Build and leak-check the judge packet for a ready slot. */
function buildReady(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    testCase: DocsTaskCase;
}): { packet: string; state: DocState } | { problem: string } {
    const trialDir = trialDirectory(options.root, options.slot.slotId);
    if (!existsSync(join(trialDir, "meta.json"))) {
        return { problem: `slot ${options.slot.slotId} has no recorded trial` };
    }
    if (
        options.testCase.primaryCheck !== undefined &&
        readPrimaryCheck(trialDir) === null
    ) {
        return {
            problem: `slot ${options.slot.slotId} has no primary-check result to judge`,
        };
    }
    const built = buildPacket(options);
    if (!built.ok) {
        return {
            problem: `judge packet for ${options.slot.slotId} is unavailable: ${built.problems.join("; ")}`,
        };
    }
    const leaks = campaignLeaks(built.packet, options.manifest, options.root);
    return leaks.length > 0
        ? {
              problem: `judge packet for ${options.slot.slotId} is not arm-blind: ${leaks.join(", ")}`,
          }
        : built;
}

/** The recorded facts recovery eligibility is decided from. */
function recoveryFacts(
    root: string,
    slot: Slot,
    attempts: RecordedAttempt[],
): Parameters<typeof recoveryDecision>[1] {
    const last = attempts.at(-1) as RecordedAttempt;
    return {
        attemptStatus: last.meta.judgementStatus,
        failureClass: last.meta.failureClass,
        completionComplete: last.meta.complete,
        attemptIds: attempts.map((entry) => entry.attemptId),
        judgedAttemptIds: attempts
            .filter((entry) => entry.meta.judgementStatus === "judged")
            .map((entry) => entry.attemptId),
        recoveryClaimsUsed: claimUsage(claimsRoot(root), "recovery").claimed,
        judgeClaimsUsed: claimUsage(claimsRoot(root), "judge").claimed,
        ledgerState: "open" as const,
        freezeProblems: [],
        unresolvedReservations: readClaims(claimsRoot(root), "judge")
            .filter(
                (entry) =>
                    entry.stamp === slot.slotId && entry.state !== "closed",
            )
            .map((entry) => entry.path),
    };
}

/** Claim the next initial or recovery dispatch for one slot. */
function claimAttempt(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    attempts: RecordedAttempt[];
    policy: RecoveryPolicy | null;
    now: () => string;
}): { attemptId: string; claims: DispatchClaims } | { problem: string } {
    if (options.attempts.length === 0) {
        const claimed = claimInitial(
            options.root,
            judgeCeiling(options.manifest, options.policy),
            options.slot,
            "attempt-001",
            options.now,
        );
        return claimed.ok
            ? {
                  attemptId: "attempt-001",
                  claims: { judge: claimed.claim },
              }
            : { problem: claimed.problem };
    }
    if (options.policy === null) {
        return {
            problem: `slot ${options.slot.slotId} has an unusable judge attempt; no recovery policy is registered`,
        };
    }
    const decision = recoveryDecision(
        options.policy,
        recoveryFacts(options.root, options.slot, options.attempts),
    );
    if (!decision.eligible) {
        return { problem: `slot ${options.slot.slotId}: ${decision.reason}` };
    }
    const policy = options.policy;
    const admitted = withAdmission(options.root, () => {
        const ledger = readLedger(options.root);
        if (ledger.state === "closed") {
            return { kind: "closed" as const };
        }
        if (ledger.state === "malformed") {
            return { kind: "malformed" as const, problems: ledger.problems };
        }
        return {
            kind: "claim" as const,
            claimed: claimRecoveryBudget(
                claimsRoot(options.root),
                {
                    ...policy,
                    totalJudgeAttempts: judgeCeiling(options.manifest, policy),
                },
                {
                    stamp: options.slot.slotId,
                    attemptId: decision.attemptId,
                    key: `${options.slot.slotId}/${decision.attemptId}`,
                    at: options.now(),
                },
            ),
        };
    });
    if (!admitted.ok) {
        return { problem: `slot ${options.slot.slotId}: ${admitted.problem}` };
    }
    if (admitted.value.kind === "closed") {
        return {
            problem:
                "campaign is closed; no further recovery dispatch is permitted",
        };
    }
    if (admitted.value.kind === "malformed") {
        return {
            problem: `slot ${options.slot.slotId}: attempt ledger is malformed: ${admitted.value.problems.join("; ")}`,
        };
    }
    const claimed = admitted.value.claimed;
    return claimed.ok
        ? {
              attemptId: decision.attemptId,
              claims: {
                  judge: claimed.judge,
                  recovery: claimed.recovery,
              },
          }
        : { problem: `slot ${options.slot.slotId}: ${claimed.reason}` };
}

/** The terminal refusal for a slot whose attempts are all unusable. */
function lastFailure(
    slot: Slot,
    attempts: RecordedAttempt[],
): {
    status: "refused";
    problems: string[];
} {
    const last = attempts.at(-1) as RecordedAttempt;
    return {
        status: "refused",
        problems: [
            `slot ${slot.slotId} judge attempt ${last.attemptId} was ${last.meta.judgementStatus}` +
                (last.meta.failureClass === null
                    ? ""
                    : ` (${last.meta.failureClass})`),
        ],
    };
}

/** The packet a dispatch will use, writing it once on the first attempt. */
function ensurePacket(
    existing: { packet: string; sha256: string } | null,
    root: string,
    slotId: string,
    built: string,
): { packet: string; sha256: string } | { problem: string } {
    if (existing !== null) return existing;
    const frozen = packetFor(root, slotId, built);
    return frozen.ok
        ? { packet: frozen.packet, sha256: frozen.sha256 }
        : { problem: frozen.problem };
}

/** Store the usable judgement and return the slot's terminal result. */
function settleJudged(options: {
    root: string;
    manifest: PreparedManifest;
    slot: Slot;
    attempts: RecordedAttempt[];
    selectedAttemptId: string;
    policy: RecoveryPolicy | null;
    now: () => string;
}): { status: "judged" | "refused"; problems: string[] } {
    const selected = recordSelection(options);
    return selected.ok
        ? { status: "judged", problems: [] }
        : { status: "refused", problems: selected.problems };
}

/** Dispatch and recover for one ready slot. */
async function executeAttempts(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    policy: RecoveryPolicy | null;
    built: { packet: string; state: DocState };
    judgeModel: string;
    attempts: RecordedAttempt[];
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<{ status: "judged" | "refused"; problems: string[] }> {
    let attempts = options.attempts;
    let packet: { packet: string; sha256: string } | null = null;
    const maximumAttempts = 1 + (options.policy?.maxRecoveriesPerSlot ?? 0);
    for (let iteration = 0; iteration < maximumAttempts; iteration += 1) {
        const claimed = claimAttempt({ ...options, attempts });
        if ("problem" in claimed) {
            return { status: "refused", problems: [claimed.problem] };
        }
        const ensured = ensurePacket(
            packet,
            options.root,
            options.slot.slotId,
            options.built.packet,
        );
        if ("problem" in ensured) {
            releaseClaims(claimed.claims);
            return { status: "refused", problems: [ensured.problem] };
        }
        packet = ensured;
        const dispatched = await dispatchAttempt({
            root: options.root,
            manifest: options.manifest,
            frozen: options.frozen,
            slot: options.slot,
            caseId: options.slot.caseId,
            attemptId: claimed.attemptId,
            packet: packet.packet,
            packetSha256: packet.sha256,
            judgeModel: options.judgeModel,
            state: options.built.state,
            claims: claimed.claims,
            execute: options.execute,
            now: options.now,
        });
        if (!dispatched.ok) {
            return { status: "refused", problems: [dispatched.problem] };
        }
        attempts = [...attempts, dispatched.attempt];
        if (dispatched.attempt.meta.judgementStatus === "judged") {
            return settleJudged({
                root: options.root,
                manifest: options.manifest,
                slot: options.slot,
                attempts,
                selectedAttemptId: claimed.attemptId,
                policy: options.policy,
                now: options.now,
            });
        }
        if (options.policy === null) return lastFailure(options.slot, attempts);
    }
    return lastFailure(options.slot, attempts);
}

/** Judge one slot, including at most one registered recovery. */
async function judgeSlot(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    slot: Slot;
    policy: RecoveryPolicy | null;
    dryRun: boolean;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<{ status: "judged" | "skipped" | "refused"; problems: string[] }> {
    const resolved = resolveCase(options.manifest, options.slot);
    if ("problem" in resolved) {
        return { status: "refused", problems: [resolved.problem] };
    }
    const recorded = recordedAttempts(options.root, options.slot.slotId);
    if (recorded.problems.length > 0) {
        return { status: "refused", problems: recorded.problems };
    }
    const settled = settleExisting({ ...options, attempts: recorded.attempts });
    if (settled !== null) return settled;
    const ready = buildReady({ ...options, ...resolved });
    if ("problem" in ready) {
        return { status: "refused", problems: [ready.problem] };
    }
    return options.dryRun
        ? { status: "judged", problems: [] }
        : executeAttempts({
              ...options,
              ...resolved,
              built: ready,
              attempts: recorded.attempts,
          });
}

/** One slot result added to the campaign tally. */
interface JudgeTally {
    judged: string[];
    skipped: string[];
    refused: string[];
    problems: string[];
}

/** Fold one slot result into the tally. */
function tallyResult(
    tally: JudgeTally,
    slotId: string,
    result: { status: "judged" | "skipped" | "refused"; problems: string[] },
): void {
    if (result.status === "judged") tally.judged.push(slotId);
    else if (result.status === "skipped") tally.skipped.push(slotId);
    else tally.refused.push(slotId);
    tally.problems.push(...result.problems);
}

/** Throw for a judge selector that the prepared schedule does not contain. */
function refuseUnknownJudgedSlots(
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
function judgeSlots(
    manifest: PreparedManifest,
    slotIds: readonly string[] | undefined,
): Slot[] {
    if (slotIds === undefined) return manifest.campaign.schedule.slots;
    return slotIds.map((slotId) => {
        const found = manifest.campaign.schedule.slots.find(
            (entry) => entry.slotId === slotId,
        );
        if (found === undefined) throw new Error(`unknown slotId ${slotId}`);
        return found;
    });
}

/**
 * Judge every selected slot from checked evidence. A usable selection is
 * idempotent; a complete `json-syntax` failure is recovered once when a policy
 * is registered, from the same packet bytes and against durable ceilings.
 * @param root The frozen campaign root.
 * @param options Slot selection and dry-run choice.
 * @param options.slotIds The selected slots.
 * @param options.dryRun Build and check the packet without dispatching.
 * @param deps Injected process runner and clock.
 * @returns What was judged, skipped or refused.
 */
export async function judgeCampaign(
    root: string,
    options: { slotIds?: readonly string[]; dryRun?: boolean } = {},
    deps: JudgeDeps = {},
): Promise<JudgeSummary> {
    refuseUnknownJudgedSlots(root, options.slotIds);
    const state = judgeState(root, deps.tool);
    if (!state.ok) {
        return {
            ok: false,
            judged: [],
            skipped: [],
            refused: [],
            problems: state.problems,
        };
    }
    const manifest = state.manifest;
    const execute = deps.runContainer ?? runContainer;
    const now = deps.now ?? (() => new Date().toISOString());
    const tally = await judgeInOrder({
        root,
        manifest,
        frozen: state.frozen,
        policy: state.policy,
        slots: judgeSlots(manifest, options.slotIds),
        dryRun: options.dryRun === true,
        execute,
        now,
    });
    return {
        ok: tally.refused.length === 0 && tally.problems.length === 0,
        ...tally,
    };
}

/** Judge one slot and report whether its checked verdict was adverse. */
async function judgeOne(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    policy: RecoveryPolicy | null;
    slot: Slot;
    dryRun: boolean;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<{
    result: { status: "judged" | "skipped" | "refused"; problems: string[] };
    adverse: boolean;
}> {
    const result = await judgeSlot(options);
    const selected =
        result.status === "judged" && !options.dryRun
            ? readSelectedJudgement(options.root, options.slot.slotId)
            : null;
    return {
        result,
        adverse: isAdverseOutcome(selected?.judgement.documentationOutcome),
    };
}

/** Judge selected slots in order, honouring the declared stop policy. */
async function judgeInOrder(options: {
    root: string;
    manifest: PreparedManifest;
    frozen: FrozenRecord;
    policy: RecoveryPolicy | null;
    slots: readonly Slot[];
    dryRun: boolean;
    execute: (plan: ContainerPlan) => Promise<CommandResult>;
    now: () => string;
}): Promise<JudgeTally> {
    const tally: JudgeTally = {
        judged: [],
        skipped: [],
        refused: [],
        problems: [],
    };
    for (const slot of options.slots) {
        const { result, adverse } = await judgeOne({ ...options, slot });
        tallyResult(tally, slot.slotId, result);
        if (
            judgeShouldStop(options.manifest.campaign, {
                problems: result.problems,
                adverse,
            })
        ) {
            break;
        }
    }
    return tally;
}

/** Read a slot's attempt metadata, sorted by attempt id. */
export function readJudgeAttempts(
    root: string,
    slotId: string,
): JudgeAttemptMeta[] {
    return namesOf(judgeDirectory(root, slotId)).flatMap((attemptId) => {
        const value = readObject(
            join(attemptDirectory(root, slotId, attemptId), "meta.json"),
        );
        return value === null ? [] : [value as unknown as JudgeAttemptMeta];
    });
}

/** One selected judgement and the attempt that produced it. */
export interface SelectedJudgement {
    /** The checked selection record. */
    selection: SelectionRecord;
    /** The selected attempt's metadata. */
    meta: JudgeAttemptMeta;
    /** The stored judgement. */
    judgement: StoredJudgement;
}

/**
 * Read the selected judgement for one slot, or null when no usable selection
 * exists. The selection is evidence, so callers validate it separately.
 * @param root The campaign root.
 * @param slotId The slot id.
 * @returns The selected attempt's stored judgement, or null.
 */
export function readSelectedJudgement(
    root: string,
    slotId: string,
): SelectedJudgement | null {
    const checked = checkedSelectionForSlot(root, slotId);
    return checked.ok
        ? {
              selection: checked.value.selection,
              meta: checked.value.meta,
              judgement: checked.value.judgement,
          }
        : null;
}

/**
 * Build a judge sandbox plan for one docs slot without claiming a budget or
 * dispatching. Internal smoke/ops hook: it uses the production mount plan and
 * packet builder, and writes only into a fresh temporary attempt directory.
 * @param root The campaign root.
 * @param slotId The scheduled docs slot.
 * @param attemptId The attempt identity to render.
 * @returns The plan, or every refusal.
 */
export function judgeSandboxPlanForSlot(
    root: string,
    slotId: string,
    attemptId: string,
): { ok: true; plan: ContainerPlan } | { ok: false; problems: string[] } {
    const prepared = loadPreparedManifest(root);
    if (!prepared.ok) return { ok: false, problems: [prepared.problem] };
    const frozen = loadFrozen(root);
    if (!frozen.ok) return { ok: false, problems: [frozen.problem] };
    const slot = prepared.manifest.campaign.schedule.slots.find(
        (entry) => entry.slotId === slotId,
    );
    const testCase = prepared.manifest.suite.cases.find(
        (entry) => entry.caseId === slot?.caseId,
    );
    const judgeModel = prepared.manifest.campaign.assessment.judge?.model;
    if (slot === undefined || testCase?.kind !== "docs-task") {
        return { ok: false, problems: [`slot ${slotId} has no docs case`] };
    }
    if (judgeModel === undefined) {
        return {
            ok: false,
            problems: ["the campaign declares no judge model"],
        };
    }
    const built = buildPacket({ root, slot, testCase });
    if (!built.ok) return built;
    const directory = mkdtempSync(join(tmpdir(), "otc-judge-plan-"));
    const packetFile = join(directory, "packet.md");
    writeFileSync(packetFile, built.packet, "utf8");
    const planned = planAttempt({
        root,
        campaign: prepared.manifest.campaign,
        slot,
        attemptId,
        packet: built.packet,
        packetSha256: sha256Bytes(built.packet),
        packetFile,
        judgeModel,
        attemptDirOverride: directory,
    });
    if (!planned.ok) return planned;
    planned.plan.imageId = frozen.record.imageId;
    return { ok: true, plan: planned.plan };
}
