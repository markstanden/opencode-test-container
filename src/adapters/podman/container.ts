import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runCommand, type CommandResult } from "../process.ts";

/** One bind mount in a trial sandbox. */
export interface Mount {
    /** The source value. */
    source: string;
    /** The target value. */
    target: string;
    /** The read only value. */
    readOnly: boolean;
}

/** The complete sandbox plan for one trial. */
export interface ContainerPlan {
    /** The image id value. */
    imageId: string;
    /** The mounts value. */
    mounts: Mount[];
    /** The workdir value. */
    workdir: string;
    /** The network value. */
    network: "host" | "none";
    /** The argv value. */
    argv: string[];
    /** Environment names passed by reference; values never enter argv. */
    envNames: string[];
    /** A 0600 env file read by Podman; values never enter argv. */
    envFile: string | null;
    /** The timeout ms value. */
    timeoutMs: number;
}

/** Check one proposed mount's path syntax and existence. */
function mountEntryProblems(mount: Mount): string[] {
    const problems: string[] = [];
    if (!isAbsolute(mount.source) || !isAbsolute(mount.target)) {
        problems.push(
            `mount ${mount.source} -> ${mount.target} must use absolute paths`,
        );
    }
    if (!existsSync(mount.source)) {
        problems.push(`mount source ${mount.source} does not exist`);
    }
    if (mount.target.includes(",")) {
        problems.push(`mount target ${mount.target} may not contain a comma`);
    }
    return problems;
}

/** Check for a read-write mount nested under a read-only target. */
function nestedMountProblems(targets: ReadonlyMap<string, boolean>): string[] {
    const readOnly = [...targets.entries()]
        .filter(([, value]) => value)
        .map(([target]) => target);
    const problems: string[] = [];
    for (const [target, value] of targets) {
        if (value) continue;
        if (readOnly.some((parent) => target.startsWith(`${parent}/`))) {
            problems.push(
                `read-write mount ${target} sits under a read-only mount`,
            );
        }
    }
    return problems;
}

/**
 * Validate a mount plan before it reaches Podman: absolute targets, existing
 * sources, unique targets, and no read-write mount over a read-only one.
 * @param mounts The proposed mounts.
 * @returns Problems; empty means the plan is accepted.
 */
export function mountProblems(mounts: readonly Mount[]): string[] {
    const problems = mounts.flatMap(mountEntryProblems);
    const targets = new Map<string, boolean>();
    for (const mount of mounts) {
        if (targets.has(mount.target)) {
            problems.push(`duplicate mount target ${mount.target}`);
        }
        targets.set(mount.target, mount.readOnly);
    }
    problems.push(...nestedMountProblems(targets));
    return problems;
}

/**
 * The exact Podman argv for one trial. `--userns=keep-id`, a read-only root,
 * no new privileges, dropped capabilities and a bounded /tmp are the sandbox
 * floor; network mode is declared honestly, because host networking is not
 * provider-only isolation.
 * @param plan The validated plan.
 * @returns The complete argv after `podman`.
 */
export function containerArgv(plan: ContainerPlan): string[] {
    const args = [
        "run",
        "--rm",
        "--network",
        plan.network,
        "--userns=keep-id",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,size=768m",
    ];
    for (const mount of plan.mounts) {
        args.push(
            "--mount",
            `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ",ro" : ""}`,
        );
    }
    if (plan.envFile !== null) {
        args.push("--env-file", plan.envFile);
    }
    args.push("--workdir", plan.workdir, plan.imageId, ...plan.argv);
    return args;
}

/**
 * Run one trial container.
 * @param plan The validated plan.
 * @param run Process adapter, injected for tests.
 * @returns The bounded process result.
 */
export async function runContainer(
    plan: ContainerPlan,
    run: typeof runCommand = runCommand,
): Promise<CommandResult> {
    const problems = mountProblems(plan.mounts);
    if (problems.length > 0) {
        return {
            status: null,
            signal: null,
            stdout: "",
            stderr: problems.join("; "),
            timedOut: false,
            error: "invalid mount plan",
        };
    }
    return run("podman", containerArgv(plan), {
        timeoutMs: plan.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
    });
}

/** The container-side workspace path. */
export const CONTAINER_WORKSPACE = "/workspace";

/** The container-side config home. */
export const CONTAINER_CONFIG_HOME = "/config-home";

/** The container-side subject root. */
export const CONTAINER_SUBJECTS = "/subjects";

/** The container-side journal directory, when docs instrumentation is on. */
export const CONTAINER_JOURNAL = "/journal";

/** Resolve and normalise all mount sources. */
export function normaliseMounts(mounts: readonly Mount[]): Mount[] {
    return mounts.map((mount) => ({
        ...mount,
        source: resolve(mount.source),
        target: resolve(mount.target),
    }));
}
