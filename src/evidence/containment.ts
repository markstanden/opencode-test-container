/**
 * Contained evidence reads.
 *
 * Trial workspaces are written by an untrusted subject, so every host-side
 * read of workspace content goes through this module. A workspace (or lake)
 * root must be a real directory, no symlinked ancestor may leave it, and a
 * file read opens the final component with `O_NOFOLLOW`. Directories reached
 * through a symlink are never traversed, and special files are refused rather
 * than opened (a FIFO would otherwise hang the reader).
 *
 * Threat model: the subject runs in a container that has stopped before these
 * reads. A final-component swap is defeated by `O_NOFOLLOW`; a parent swap
 * needs write access to the campaign root after the container stops, which is
 * the same trust as editing the evidence directly and is out of scope. This
 * detects an escaping object, not a host operator who can rewrite every record.
 */
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** One successful contained text read, or the refusal. */
export type ContainedText =
    | { ok: true; text: string }
    | { ok: false; problem: string };

/** One successful contained document, or the refusal. */
export type ContainedDocuments =
    | { ok: true; documents: Array<{ path: string; contents: string }> }
    | { ok: false; problem: string };

/** Whether a relative path stays under its root without normalisation tricks. */
export function isSafeRelativePath(path: string): boolean {
    if (path === "" || isAbsolute(path) || path.includes("\0")) return false;
    const normalised = resolve("/", path);
    const rel = relative("/", normalised);
    return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Resolve a root, refusing a symlink at the root itself. */
function realRoot(root: string): { ok: true; path: string } | { ok: false; problem: string } {
    try {
        const stat = lstatSync(root);
        if (stat.isSymbolicLink()) {
            return {
                ok: false,
                problem: `${root} is a symlink; a workspace root must be a real directory`,
            };
        }
        if (!stat.isDirectory()) {
            return { ok: false, problem: `${root} is not a directory` };
        }
        return { ok: true, path: realpathSync(root) };
    } catch (error) {
        return {
            ok: false,
            problem: `${root}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** Whether a resolved path is inside a resolved root. */
function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve one path relative to a contained root. A symlink at any component is
 * allowed only when its target stays inside the root; the returned path is the
 * real target, which the caller opens without following a final symlink.
 * @param root The contained root (a real directory).
 * @param path The root-relative path.
 * @returns The real path, or the refusal.
 */
export function resolveContained(
    root: string,
    path: string,
): { ok: true; path: string } | { ok: false; problem: string } {
    if (!isSafeRelativePath(path)) {
        return { ok: false, problem: `${path} is not a safe relative path` };
    }
    const base = realRoot(root);
    if (!base.ok) return base;
    const candidate = join(base.path, path);
    try {
        const real = realpathSync(candidate);
        if (!inside(base.path, real)) {
            return { ok: false, problem: `${path} resolves outside ${root}` };
        }
        return { ok: true, path: real };
    } catch (error) {
        return {
            ok: false,
            problem: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Read one root-relative regular file without following a symlink at the final
 * component.
 * @param root The contained root.
 * @param path The root-relative path.
 * @returns The text, or the refusal.
 */
export function readContainedFile(
    root: string,
    path: string,
    options: { beforeOpen?: (realPath: string) => void } = {},
): ContainedText {
    const resolved = resolveContained(root, path);
    if (!resolved.ok) return resolved;
    let fd: number | null = null;
    try {
        options.beforeOpen?.(resolved.path);
        fd = openSync(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile()) {
            return {
                ok: false,
                problem: `${path} is not a regular file`,
            };
        }
        return { ok: true, text: readFileSync(fd, "utf8") };
    } catch (error) {
        return {
            ok: false,
            problem: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        if (fd !== null) closeSync(fd);
    }
}

/** A snapshot of one directory's regular files, refused on any unsafe object. */
interface WalkResult {
    ok: boolean;
    problem: string | null;
    files: Array<{ path: string; contents: string }>;
}

/** Walk one directory without traversing symlinked directories or special files. */
function walk(
    root: string,
    realBase: string,
    directory: string,
    accept: (name: string) => boolean,
): WalkResult {
    const files: Array<{ path: string; contents: string }> = [];
    const names = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of names) {
        const path = join(directory, entry.name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            const relativePath = relative(realBase, path).split(sep).join("/");
            const resolved = resolveContained(root, relativePath);
            if (!resolved.ok) return { ok: false, problem: resolved.problem, files };
            const target = lstatSync(resolved.path);
            if (target.isDirectory()) {
                return {
                    ok: false,
                    problem: `${relativePath} is a symlinked directory; directories are not traversed`,
                    files,
                };
            }
            if (!target.isFile()) {
                return {
                    ok: false,
                    problem: `${relativePath} resolves to a special file`,
                    files,
                };
            }
            if (accept(entry.name)) {
                const text = readContainedFile(root, relativePath);
                if (!text.ok) return { ok: false, problem: text.problem, files };
                files.push({ path: relativePath, contents: text.text });
            }
            continue;
        }
        if (stat.isDirectory()) {
            const nested = walk(root, realBase, path, accept);
            if (!nested.ok) return nested;
            files.push(...nested.files);
            continue;
        }
        if (!stat.isFile()) {
            return {
                ok: false,
                problem: `${relative(root, path)} is not a regular file`,
                files,
            };
        }
        if (accept(entry.name)) {
            const relativePath = relative(realBase, path).split(sep).join("/");
            const text = readContainedFile(root, relativePath);
            if (!text.ok) return { ok: false, problem: text.problem, files };
            files.push({ path: relativePath, contents: text.text });
        }
    }
    return { ok: true, problem: null, files };
}

/**
 * Read every accepted regular file under one contained directory.
 * @param root The contained root (a real directory).
 * @param directory The root-relative directory; "" means the root itself.
 * @param accept A filename predicate, such as a `.md` suffix.
 * @returns The documents keyed by root-relative path, or the refusal.
 */
export function readContainedDocuments(
    root: string,
    directory: string,
    accept: (name: string) => boolean,
): ContainedDocuments {
    const base = realRoot(root);
    if (!base.ok) return base;
    const directoryPath = directory === "" ? root : join(root, directory);
    let realDirectory: string;
    try {
        const stat = lstatSync(directoryPath);
        if (stat.isSymbolicLink()) {
            return {
                ok: false,
                problem: `${directory} is a symlink; a lake root must be a real directory`,
            };
        }
        if (!stat.isDirectory()) {
            return { ok: false, problem: `${directory} is not a directory` };
        }
        realDirectory = realpathSync(directoryPath);
        if (!inside(base.path, realDirectory)) {
            return {
                ok: false,
                problem: `${directory} resolves outside ${root}`,
            };
        }
    } catch (error) {
        return {
            ok: false,
            problem: `${directory}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const walked = walk(root, base.path, realDirectory, accept);
    return walked.ok
        ? { ok: true, documents: walked.files }
        : { ok: false, problem: walked.problem ?? "unsafe evidence object" };
}

/** The kind of object at a root-relative path, without opening it. */
export type ContainedEntry =
    | { ok: true; kind: "missing" | "file" | "directory" | "symlink" }
    | { ok: false; problem: string };

/**
 * Classify one root-relative path without following a final symlink. A
 * dangling or escaping symlink is a refusal, never "missing": refusing is the
 * only safe interpretation when the object's identity is unknown.
 * @param root The contained root.
 * @param path The root-relative path.
 * @returns The entry kind, or the refusal.
 */
export function containedEntry(root: string, path: string): ContainedEntry {
    if (!isSafeRelativePath(path)) {
        return { ok: false, problem: `${path} is not a safe relative path` };
    }
    const base = realRoot(root);
    if (!base.ok) return base;
    let current = base.path;
    const parts = path.split("/").filter((part) => part !== "");
    for (const [index, part] of parts.entries()) {
        const candidate = join(current, part);
        let stat;
        try {
            stat = lstatSync(candidate);
        } catch {
            return { ok: true, kind: "missing" };
        }
        const last = index === parts.length - 1;
        if (stat.isSymbolicLink()) {
            let real: string;
            try {
                real = realpathSync(candidate);
            } catch {
                return {
                    ok: false,
                    problem: `${path} is a dangling or unreadable symlink`,
                };
            }
            if (!inside(base.path, real)) {
                return { ok: false, problem: `${path} resolves outside ${root}` };
            }
            if (last) return { ok: true, kind: "symlink" };
            const target = lstatSync(real);
            if (!target.isDirectory()) {
                return {
                    ok: false,
                    problem: `${path} crosses a symlink to a non-directory`,
                };
            }
            current = real;
            continue;
        }
        if (last) {
            return {
                ok: true,
                kind: stat.isDirectory()
                    ? "directory"
                    : stat.isFile()
                      ? "file"
                      : "symlink",
            };
        }
        if (!stat.isDirectory()) {
            return {
                ok: false,
                problem: `${path} crosses a non-directory`,
            };
        }
        current = candidate;
    }
    return { ok: true, kind: "directory" };
}
