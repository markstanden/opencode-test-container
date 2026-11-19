/**
 * Pure container-plan shapes and mount normalisation.
 *
 * Execution lives in `container.ts`; this module has no filesystem, process,
 * clock or random dependency so plan builders can be checked for purity.
 */
import { resolve } from "node:path";

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
    /**
     * Exact text streamed to the container's stdin. Used for content too large
     * for the host's single-argument limit; the stream is closed immediately.
     */
    stdin?: string;
    /** Environment names passed by reference; values never enter argv. */
    envNames: string[];
    /** A 0600 env file read by Podman; values never enter argv. */
    envFile: string | null;
    /** The timeout ms value. */
    timeoutMs: number;
    /** A unique owned container name, used for bounded cleanup. */
    name?: string;
    /** Ownership labels recorded on the container. */
    labels?: Record<string, string>;
    /** Cancels the dispatch with bounded cleanup. */
    signal?: AbortSignal;
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
