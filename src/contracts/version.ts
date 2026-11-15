/**
 * The package and evaluator identity frozen with every campaign.
 *
 * The version comes from the installed package metadata, so a tarball can be
 * traced to the artefact that produced its evidence without a Git checkout.
 * The evaluator version changes only when the checked semantics change.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The frozen evaluator-semantics version. */
export const EVALUATOR_VERSION = 1;

/** The package name recorded in every manifest and freeze receipt. */
export const PACKAGE_NAME = "@markstanden/opencode-test-container";

/**
 * Read the installed package version, or `unknown` when the metadata is
 * unavailable. This never reads the caller's working directory.
 * @returns The version string.
 */
export function packageVersion(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
        join(here, "..", "..", "package.json"),
        join(here, "..", "package.json"),
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

/** The tool identity every manifest and freeze receipt carries. */
export interface ToolIdentity {
    /** The package name. */
    name: string;
    /** The installed package version, or `unknown`. */
    version: string;
    /** The checked evaluator-semantics version. */
    evaluatorVersion: number;
}

/** Build the current tool identity. */
export function toolIdentity(): ToolIdentity {
    return {
        name: PACKAGE_NAME,
        version: packageVersion(),
        evaluatorVersion: EVALUATOR_VERSION,
    };
}
