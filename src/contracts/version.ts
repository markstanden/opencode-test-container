/**
 * The package and evaluator identity frozen with every campaign.
 *
 * The version comes from the installed package metadata and the artifact hash
 * from the executing runtime tree, so a tarball can be traced to the artefact
 * that produced its evidence without a Git checkout. The artifact hash covers
 * executable JavaScript (or TypeScript when running from source) and the
 * package manifest, so a changed build under the same version is detectable.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The frozen evaluator-semantics version. */
export const EVALUATOR_VERSION = 1;

/** The package name recorded in every manifest and freeze receipt. */
export const PACKAGE_NAME = "@markstanden/opencode-test-container";

/** The installed package root, two levels above this module. */
export function packageRoot(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Read the installed package version, or `unknown` when the metadata is
 * unavailable. This never reads the caller's working directory.
 * @returns The version string.
 */
export function packageVersion(): string {
    const root = packageRoot();
    for (const candidate of [
        join(root, "package.json"),
        join(root, "..", "package.json"),
    ]) {
        try {
            const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                "version" in parsed &&
                typeof parsed.version === "string"
            ) {
                return parsed.version;
            }
        } catch {
            // try the next candidate
        }
    }
    return "unknown";
}

/** The runtime tree that is actually executing: `dist` when built, else `src`. */
function runtimeRoot(root: string): string {
    return existsSync(join(root, "dist", "contracts", "version.js"))
        ? join(root, "dist")
        : join(root, "src");
}

/** Every file under a root, sorted by relative path. */
function filesUnder(root: string): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, {
            withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
                files.push(path);
            }
        }
    };
    if (existsSync(root)) walk(root);
    return files.sort();
}

/**
 * The content identity of the executing runtime tree.
 * @param root The package root; defaults to the running installation.
 * @returns A stable SHA-256 over sorted paths and file bytes.
 */
export function artifactSha256(root: string = packageRoot()): string {
    const hash = createHash("sha256");
    for (const path of filesUnder(runtimeRoot(root))) {
        hash.update(relative(root, path).split(sep).join("/"));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
    }
    const manifest = join(root, "package.json");
    if (existsSync(manifest) && statSync(manifest).isFile()) {
        hash.update("package.json\0");
        hash.update(readFileSync(manifest));
    }
    return hash.digest("hex");
}

/** The tool identity every manifest and freeze receipt carries. */
export interface ToolIdentity {
    /** The package name. */
    name: string;
    /** The installed package version, or `unknown`. */
    version: string;
    /** The checked evaluator-semantics version. */
    evaluatorVersion: number;
    /** The executing runtime content hash. */
    artifactSha256: string;
}

let cachedIdentity: ToolIdentity | null = null;

/**
 * Build the current tool identity. The default installation is cached; an
 * explicit root is always recomputed.
 * @param root The package root; defaults to the running installation.
 * @returns The identity.
 */
export function toolIdentity(root?: string): ToolIdentity {
    if (root === undefined && cachedIdentity !== null) return cachedIdentity;
    const identity: ToolIdentity = {
        name: PACKAGE_NAME,
        version: packageVersion(),
        evaluatorVersion: EVALUATOR_VERSION,
        artifactSha256: artifactSha256(root),
    };
    if (root === undefined) cachedIdentity = identity;
    return identity;
}

/**
 * Compare the frozen identity with the installation that is executing now.
 * @param frozen The identity recorded at freeze time.
 * @param current The executing identity.
 * @returns Differences; empty means the same artefact.
 */
export function toolIdentityProblems(
    frozen: ToolIdentity,
    current: ToolIdentity = toolIdentity(),
): string[] {
    const problems: string[] = [];
    if (frozen.name !== current.name) {
        problems.push(
            `frozen tool name ${frozen.name} differs from executing ${current.name}`,
        );
    }
    if (frozen.version !== current.version) {
        problems.push(
            `frozen tool version ${frozen.version} differs from executing ${current.version}`,
        );
    }
    if (frozen.evaluatorVersion !== current.evaluatorVersion) {
        problems.push(
            `frozen evaluator version ${frozen.evaluatorVersion} differs from executing ${current.evaluatorVersion}`,
        );
    }
    if (frozen.artifactSha256 !== current.artifactSha256) {
        problems.push(
            `frozen tool artifact ${frozen.artifactSha256} differs from executing ${current.artifactSha256}`,
        );
    }
    return problems;
}
