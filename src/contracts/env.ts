/**
 * Environment variable rules for one sandbox session.
 *
 * OTC owns the session's HOME, XDG directories, OpenCode configuration content
 * and docs-journal controls; a campaign may never override them. Names must be
 * portable POSIX identifiers, and values may not contain newline, carriage
 * return or NUL because they are written to a Podman env file.
 */

/** Exact names OTC reserves for its own session wiring. */
export const RESERVED_ENVIRONMENT_NAMES = [
    "HOME",
    "OPENCODE_CONFIG_CONTENT",
    "DOCS_OPERATION_JOURNAL",
    "DOCS_OPERATION_JOURNAL_KEY",
] as const;

/** Whether a name is reserved by prefix as well as exactly. */
function reserved(name: string): boolean {
    return (
        (RESERVED_ENVIRONMENT_NAMES as readonly string[]).includes(name) ||
        name.startsWith("XDG_") ||
        name.startsWith("DOCS_OPERATION_JOURNAL")
    );
}

/**
 * Why a variable name cannot be passed through, or null when acceptable.
 * @param name The proposed environment name.
 * @returns The refusal, or null.
 */
export function environmentNameProblem(name: string): string | null {
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        return `${name} is not a valid environment name`;
    }
    if (reserved(name)) {
        return `${name} is reserved by OTC and cannot be overridden`;
    }
    return null;
}

/**
 * Why a variable value cannot be written to an env file, or null when safe.
 * The message names the variable but never includes its value.
 * @param name The variable name.
 * @param value The proposed value.
 * @returns The refusal, or null.
 */
export function environmentValueProblem(
    name: string,
    value: string,
): string | null {
    return /[\n\r\0]/.test(value)
        ? `${name} contains a newline, carriage return or NUL`
        : null;
}
