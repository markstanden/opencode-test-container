/**
 * Pure plan builders for trial and judge containers.
 *
 * Staging commands resolve host paths, environment and nonce values, then
 * delegate the calculation here. These functions read no disk, environment,
 * clock or random source and never mutate their inputs.
 */
import {
    CONTAINER_CONFIG_HOME,
    CONTAINER_JOURNAL,
    CONTAINER_SUBJECTS,
    CONTAINER_WORKSPACE,
    normaliseMounts,
    type ContainerPlan,
    type Mount,
} from "../adapters/podman/plan.ts";

/** The explicit values a trial plan is built from. */
export interface TrialPlanValues {
    /** The frozen image identity. */
    imageId: string;
    /** The resolved writable workspace mount. */
    workspace: string;
    /** The resolved read-only config home. */
    configHome: string;
    /** The resolved read-only subject payload. */
    subjects: string;
    /** The resolved writable docs journal, or null when the case has none. */
    journal: string | null;
    /** The container working directory. */
    workdir: string;
    /** The declared network mode. */
    network: ContainerPlan["network"];
    /** The complete opencode argument vector. */
    argv: readonly string[];
    /** The 0600 environment file path. */
    envFile: string;
    /** The environment variable names the file carries. */
    envNames: readonly string[];
    /** The declared timeout. */
    timeoutMs: number;
    /** The owned container name. */
    name: string;
    /** The ownership labels. */
    labels: Record<string, string>;
}

/** The trial work mounts: workspace writable, config and subjects read-only. */
function trialMounts(values: {
    workspace: string;
    configHome: string;
    subjects: string;
    journal: string | null;
}): Mount[] {
    const mounts: Mount[] = [
        {
            source: values.workspace,
            target: CONTAINER_WORKSPACE,
            readOnly: false,
        },
        {
            source: values.configHome,
            target: CONTAINER_CONFIG_HOME,
            readOnly: true,
        },
        {
            source: values.subjects,
            target: CONTAINER_SUBJECTS,
            readOnly: true,
        },
    ];
    if (values.journal !== null) {
        mounts.push({
            source: values.journal,
            target: CONTAINER_JOURNAL,
            readOnly: false,
        });
    }
    return normaliseMounts(mounts);
}

/** The judge work mounts: packet and config read-only, work writable. */
function judgeMounts(values: {
    packet: string;
    configHome: string;
    work: string;
}): ContainerPlan["mounts"] {
    return normaliseMounts([
        { source: values.packet, target: "/judge/packet.md", readOnly: true },
        { source: values.configHome, target: "/config-home", readOnly: true },
        { source: values.work, target: "/judge/work", readOnly: false },
    ]);
}

/**
 * Build one complete trial plan from resolved values.
 * @param values The resolved plan values.
 * @returns The container plan.
 */
export function buildTrialPlan(values: TrialPlanValues): ContainerPlan {
    return {
        imageId: values.imageId,
        mounts: trialMounts({
            workspace: values.workspace,
            configHome: values.configHome,
            subjects: values.subjects,
            journal: values.journal,
        }),
        workdir: values.workdir,
        network: values.network,
        argv: [...values.argv],
        envNames: [...new Set(values.envNames)],
        envFile: values.envFile,
        timeoutMs: values.timeoutMs,
        name: values.name,
        labels: { ...values.labels },
    };
}

/** The explicit values one judge attempt's plan is built from. */
export interface AttemptPlanValues {
    /** The frozen image identity. */
    imageId: string;
    /** The blinded packet delivered on stdin. */
    packet: string;
    /** The resolved read-only packet file. */
    packetFile: string;
    /** The resolved read-only judge config home. */
    configHome: string;
    /** The resolved writable judge work area. */
    work: string;
    /** The declared network mode. */
    network: ContainerPlan["network"];
    /** The complete opencode argument vector. */
    argv: readonly string[];
    /** The 0600 environment file path. */
    envFile: string;
    /** The environment variable names the file carries. */
    envNames: readonly string[];
    /** The declared judge timeout. */
    timeoutMs: number;
    /** The owned container name. */
    name: string;
    /** The ownership labels. */
    labels: Record<string, string>;
}

/**
 * Build one judge attempt plan from resolved values.
 * @param values The resolved plan values.
 * @returns The container plan.
 */
export function buildAttemptPlan(values: AttemptPlanValues): ContainerPlan {
    return {
        imageId: values.imageId,
        mounts: judgeMounts({
            packet: values.packetFile,
            configHome: values.configHome,
            work: values.work,
        }),
        workdir: "/judge/work",
        network: values.network,
        argv: [...values.argv],
        // The blinded packet is the model's prompt. It travels on stdin so a
        // packet larger than the host's per-argument limit still arrives
        // byte for byte; it is never in the process argument vector.
        stdin: values.packet,
        envNames: [...new Set(values.envNames)],
        envFile: values.envFile,
        timeoutMs: values.timeoutMs,
        name: values.name,
        labels: { ...values.labels },
    };
}
