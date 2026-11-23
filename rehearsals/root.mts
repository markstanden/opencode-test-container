import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Directory names that are inside `base`, `base` itself included. */
function inside(root: string, base: string): boolean {
    return root === base || root.startsWith(`${base}${sep}`);
}

/**
 * Resolve the rehearsal root from an optional CLI argument.
 *
 * A maintainer rehearsal writes campaign evidence and deletes it afterwards.
 * The argument is therefore confined to the system temporary directory or the
 * current working directory: anything else is a typed mistake or a traversal
 * attempt, and is refused before a single byte is written.
 * @param argument The first positional argument, when one was given.
 * @param prefix The temporary-directory prefix used when it was not.
 * @returns An absolute path that exists only inside an allowed base.
 */
export function rehearsalRoot(
    argument: string | undefined,
    prefix: string,
): string {
    if (argument === undefined) return mkdtempSync(join(tmpdir(), prefix));
    if (!isAbsolute(argument)) {
        throw new Error(`rehearsal root must be an absolute path: ${argument}`);
    }
    const root = resolve(argument);
    const bases = new Set([
        resolve(tmpdir()),
        realpathSync(tmpdir()),
        resolve(process.cwd()),
    ]);
    if (![...bases].some((base) => inside(root, base))) {
        throw new Error(
            `rehearsal root ${root} must be inside ${[...bases].join(" or ")}`,
        );
    }
    return root;
}
