/**
 * Product-supplied primary-check execution.
 *
 * A checker is trusted product data staged during preparation. It runs after
 * the trial in its own container, with the completed workspace and the
 * pristine workspace mounted read-only and no provider environment. Its
 * source is never mounted into the trial, so expectations cannot leak to the
 * subject.
 */
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../contracts/canonical.ts";
import type { DocsTaskCase } from "../contracts/types.ts";
import {
    normaliseMounts,
    runContainer,
    type ContainerPlan,
} from "../adapters/podman/container.ts";
import type { CommandResult } from "../adapters/process.ts";
import type { PreparedCase } from "./prepare.ts";

/** One recorded primary-check outcome, kept distinct from task failure. */
export interface PrimaryCheckRecord {
    /** The schema version value. */
    schemaVersion: 1;
    /** The declared checker identity. */
    id: string;
    /** The suite-relative script name. */
    script: string;
    /** The SHA-256 of the executed script bytes. */
    sourceHash: string;
    /** The fixed interpreter. */
    command: string;
    /** The fixed argument contract. */
    args: string[];
    /** The wall-clock bound. */
    timeoutMs: number;
    /** When the checker started. */
    startedAt: string;
    /** How long it ran. */
    durationMs: number;
    /** The terminal checker state. */
    status: "pass" | "fail" | "timeout" | "error";
    /** The exit code, or null. */
    exit: number | null;
    /** The signal, or null. */
    signal: string | null;
    /** Why it could not run, when applicable. */
    reason: string | null;
    /** Captured standard output, bounded. */
    stdout: string;
    /** Captured standard error, bounded. */
    stderr: string;
}

/** The container-side checker paths. */
export const CONTAINER_CHECKER = "/checker";
/** The container-side completed workspace. */
export const CONTAINER_CHECKER_LIVE = "/live";
/** The container-side pristine workspace. */
export const CONTAINER_CHECKER_PRISTINE = "/pristine";

/** Classify one completed checker process. */
function statusOf(result: CommandResult): PrimaryCheckRecord["status"] {
    if (result.timedOut) return "timeout";
    if (result.error !== null || result.status === null) return "error";
    return result.status === 0 ? "pass" : "fail";
}

/** Write the checker's minimal environment file. */
function writeCheckerEnvironment(directory: string): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "checker.env");
    writeFileSync(
        path,
        [
            "HOME=/tmp/checker-home",
            "XDG_DATA_HOME=/tmp/checker-home/.local/share",
            "XDG_CACHE_HOME=/tmp/checker-home/.cache",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
    );
    return path;
}

/**
 * The checker plan: no network, no provider variables, no evidence root.
 * @param options The resolved paths and identity.
 * @param options.imageId The frozen image.
 * @param options.checkerDir The staged checker directory.
 * @param options.script The suite-relative script.
 * @param options.workspace The completed trial workspace.
 * @param options.pristine The prepared pristine workspace.
 * @param options.envFile The 0600 environment file.
 * @param options.timeoutMs The wall-clock bound.
 * @param options.name The owned container name for cleanup.
 * @param options.labels Ownership labels recorded on the container.
 * @param options.signal Cancels the checker with bounded cleanup.
 * @returns The validated container plan.
 */
export function primaryCheckPlan(options: {
    imageId: string;
    checkerDir: string;
    script: string;
    workspace: string;
    pristine: string;
    envFile: string;
    timeoutMs: number;
    name?: string;
    labels?: Record<string, string>;
    signal?: AbortSignal;
}): ContainerPlan {
    return {
        imageId: options.imageId,
        mounts: normaliseMounts([
            {
                source: options.workspace,
                target: CONTAINER_CHECKER_LIVE,
                readOnly: true,
            },
            {
                source: options.pristine,
                target: CONTAINER_CHECKER_PRISTINE,
                readOnly: true,
            },
            {
                source: options.checkerDir,
                target: CONTAINER_CHECKER,
                readOnly: true,
            },
        ]),
        workdir: "/tmp",
        network: "none",
        argv: [
            "node",
            `${CONTAINER_CHECKER}/${options.script}`,
            CONTAINER_CHECKER_LIVE,
            CONTAINER_CHECKER_PRISTINE,
        ],
        envNames: ["HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"],
        envFile: options.envFile,
        timeoutMs: options.timeoutMs,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
}

/**
 * Run one product primary check against a completed trial.
 * @param options The case, prepared identities and trial directory.
 * @param options.root The campaign root.
 * @param options.testCase The docs case with a declared checker.
 * @param options.prepared The prepared case record.
 * @param options.trialDir The trial evidence directory.
 * @param options.workspace The completed trial workspace.
 * @param options.imageId The frozen image identity.
 * @param options.name The owned container name for cleanup.
 * @param options.labels Ownership labels recorded on the container.
 * @param options.signal Cancels the checker with bounded cleanup.
 * @param options.run Process adapter, injected for tests.
 * @param options.now Injected clock.
 * @returns The recorded outcome and the readable record.
 */
export async function executePrimaryCheck(options: {
    root: string;
    testCase: DocsTaskCase;
    prepared: PreparedCase;
    trialDir: string;
    workspace: string;
    imageId: string;
    name?: string;
    labels?: Record<string, string>;
    signal?: AbortSignal;
    run?: typeof runContainer;
    now?: () => string;
}): Promise<{
    ok: boolean;
    record: PrimaryCheckRecord | null;
    problem: string | null;
}> {
    const spec = options.testCase.primaryCheck;
    const prepared = options.prepared.primaryCheck;
    if (spec === undefined || prepared === undefined) {
        return { ok: true, record: null, problem: null };
    }
    const checkerDir = join(options.root, "prepare", prepared.directory);
    const scriptPath = join(checkerDir, prepared.script);
    const now = options.now ?? (() => new Date().toISOString());
    const startedAt = now();
    const started = Date.now();
    const base = {
        schemaVersion: 1 as const,
        id: prepared.id,
        script: prepared.script,
        sourceHash: existsSync(scriptPath)
            ? sha256Bytes(readFileSync(scriptPath))
            : "missing",
        command: "node",
        args: [
            `${CONTAINER_CHECKER}/${prepared.script}`,
            CONTAINER_CHECKER_LIVE,
            CONTAINER_CHECKER_PRISTINE,
        ],
        timeoutMs: prepared.timeoutMs,
        startedAt,
    };
    const finish = (
        patch: Pick<
            PrimaryCheckRecord,
            "status" | "exit" | "signal" | "reason" | "stdout" | "stderr"
        >,
    ): { ok: boolean; record: PrimaryCheckRecord; problem: string | null } => {
        const record: PrimaryCheckRecord = {
            ...base,
            durationMs: Date.now() - started,
            ...patch,
            stdout: patch.stdout.slice(0, 16_000),
            stderr: patch.stderr.slice(0, 16_000),
        };
        writeFileSync(
            join(options.trialDir, "primary-check.json"),
            `${JSON.stringify(record, null, 2)}\n`,
            "utf8",
        );
        return {
            ok: record.status === "pass" || record.status === "fail",
            record,
            problem:
                record.status === "timeout" || record.status === "error"
                    ? `primary check ${record.id} ${record.status}: ${record.reason ?? record.stderr.trim()}`
                    : null,
        };
    };
    if (!existsSync(scriptPath)) {
        return finish({
            status: "error",
            exit: null,
            signal: null,
            reason: `primary checker ${prepared.script} is missing from the staged payload`,
            stdout: "",
            stderr: "",
        });
    }
    const envFile = writeCheckerEnvironment(options.trialDir);
    const plan = primaryCheckPlan({
        imageId: options.imageId,
        checkerDir,
        script: prepared.script,
        workspace: options.workspace,
        pristine: join(
            options.root,
            "prepare",
            "workspaces",
            options.testCase.caseId,
        ),
        envFile,
        timeoutMs: prepared.timeoutMs,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let result: CommandResult;
    try {
        result = await (options.run ?? runContainer)(plan);
    } finally {
        rmSync(envFile, { force: true });
    }
    return finish({
        status: statusOf(result),
        exit: result.status,
        signal: result.signal,
        reason: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
    });
}

/**
 * Read a recorded primary check without trusting its shape.
 * @param trialDir The trial evidence directory.
 * @returns The record, or null when absent or unreadable.
 */
export function readPrimaryCheck(trialDir: string): PrimaryCheckRecord | null {
    const path = join(trialDir, "primary-check.json");
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return typeof value === "object" && value !== null
            ? (value as PrimaryCheckRecord)
            : null;
    } catch {
        return null;
    }
}
