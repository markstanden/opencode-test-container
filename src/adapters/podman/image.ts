import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, type CommandResult } from "../process.ts";

/** The recorded identity and CLI version of one runtime image. */
export interface ResolvedImage {
    /** The image value. */
    image: string;
    /** The image id value. */
    imageId: string;
    /** The opencode version value. */
    opencodeVersion: string;
    /** The container cli value. */
    containerCli: string;
}

/** An image inspection, or the observed refusal. */
export type ImageResolution =
    { ok: true; image: ResolvedImage } | { ok: false; problem: string };

/** Locate the package's `container/` directory from source or dist. */
export function containerDirectory(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
        resolve(here, "../../../container"),
        resolve(here, "../../container"),
        resolve(process.cwd(), "container"),
    ]) {
        if (existsSync(join(candidate, "Containerfile"))) return candidate;
    }
    return resolve(process.cwd(), "container");
}

/** Extract a version from `opencode --version` output. */
export function parseOpencodeVersion(stdout: string): string | null {
    const match =
        /(?:opencode\s+)?v?([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?)/.exec(
            stdout.trim(),
        );
    return match?.[1] ?? null;
}

/** Resolve a tag to a normalised immutable image id. */
async function inspectImageId(
    image: string,
    run: typeof runCommand,
): Promise<{ ok: true; id: string } | { ok: false; problem: string }> {
    const inspect = await run(
        "podman",
        ["image", "inspect", "--format", "{{.Id}}", image],
        { timeoutMs: 30_000 },
    );
    if (inspect.status !== 0) {
        return {
            ok: false,
            problem: `cannot inspect image ${image}: ${inspect.stderr.trim() || inspect.error || "unknown error"}`,
        };
    }
    const raw = inspect.stdout.trim();
    if (!/^(sha256:)?[0-9a-f]{12,64}$/i.test(raw)) {
        return {
            ok: false,
            problem: `image ${image} did not report an immutable id`,
        };
    }
    return { ok: true, id: raw.startsWith("sha256:") ? raw : `sha256:${raw}` };
}

/** Read the OpenCode version the image actually contains. */
async function installedVersion(
    imageId: string,
    run: typeof runCommand,
): Promise<{ ok: true; version: string } | { ok: false; problem: string }> {
    const version = await run(
        "podman",
        [
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "opencode",
            imageId,
            "--version",
        ],
        { timeoutMs: 60_000 },
    );
    const observed = parseOpencodeVersion(version.stdout + version.stderr);
    if (version.status !== 0 || observed === null) {
        return {
            ok: false,
            problem: `image ${imageId} did not report an OpenCode version: ${version.stderr.trim() || version.error || "no output"}`,
        };
    }
    return { ok: true, version: observed };
}

/**
 * Resolve a runtime image to the immutable ID and the OpenCode version it
 * actually contains. A mutable tag alone is never accepted as frozen state.
 * @param image The image name or ID.
 * @param declaredVersion The version the campaign declared.
 * @param run The process adapter, injected for tests.
 * @returns The resolution, or the refusal.
 */
export async function resolveImage(
    image: string,
    declaredVersion: string,
    run: typeof runCommand = runCommand,
): Promise<ImageResolution> {
    const inspected = await inspectImageId(image, run);
    if (!inspected.ok) return inspected;
    const installed = await installedVersion(inspected.id, run);
    if (!installed.ok) return installed;
    if (installed.version !== declaredVersion) {
        return {
            ok: false,
            problem: `image ${inspected.id} contains OpenCode ${installed.version}, campaign declares ${declaredVersion}`,
        };
    }
    return {
        ok: true,
        image: {
            image,
            imageId: inspected.id,
            opencodeVersion: installed.version,
            containerCli: "podman",
        },
    };
}

/**
 * Build the sandbox image from the packaged recipe with explicit inputs. The
 * recipe does not float: both Node and the OpenCode CLI are build arguments.
 * @param options The build inputs.
 * @param options.tag The image tag.
 * @param options.nodeBase The pinned Node base image.
 * @param options.opencodeVersion The pinned OpenCode CLI version.
 * @param run The process adapter.
 * @returns The build result.
 */
export async function buildImage(
    options: { tag: string; nodeBase: string; opencodeVersion: string },
    run: typeof runCommand = runCommand,
): Promise<CommandResult> {
    return run(
        "podman",
        [
            "build",
            "--network",
            "host",
            "--build-arg",
            `NODE_BASE=${options.nodeBase}`,
            "--build-arg",
            `OPENCODE_VERSION=${options.opencodeVersion}`,
            "--build-arg",
            `HOST_UID=${process.getuid?.() ?? 1000}`,
            "--build-arg",
            `HOST_GID=${process.getgid?.() ?? 1000}`,
            "-t",
            options.tag,
            containerDirectory(),
        ],
        { timeoutMs: 15 * 60_000 },
    );
}

/** Read the packaged Containerfile; useful for delivery checks and docs. */
export function containerfileText(): string {
    return readFileSync(join(containerDirectory(), "Containerfile"), "utf8");
}
