import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Whether `root` is a strict descendant of `base`, never `base` itself. */
function inside(root: string, base: string): boolean {
    return root.startsWith(`${base}${sep}`);
}

/**
 * Resolve the rehearsal root from an optional CLI argument.
 *
 * A maintainer rehearsal writes campaign evidence and deletes it afterwards.
 * The argument is therefore confined to the system temporary directory or the
 * current working directory: anything else is a typed mistake or a traversal
 * attempt, and is refused before a single byte is written. Both bases are
 * refused themselves, so a legible path cannot turn the recursive cleanup into
 * a deletion of the working directory or the temporary directory.
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
    if (bases.has(root)) {
        throw new Error(
            `rehearsal root ${root} must be a strict subdirectory of ${[...bases].join(" or ")}`,
        );
    }
    if (![...bases].some((base) => inside(root, base))) {
        throw new Error(
            `rehearsal root ${root} must be a strict subdirectory of ${[...bases].join(" or ")}`,
        );
    }
    return root;
}
