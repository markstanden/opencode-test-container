import { createHash } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    symlinkSync,
    copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** One file identity in an immutable inventory. */
export interface InventoryEntry {
    /** The path value. */
    path: string;
    /** The sha256 value. */
    sha256: string;
    /** Present only for a contained symlink, recording its relative target. */
    link?: string;
}

/** A deterministic inventory of a directory tree. */
export type Inventory = InventoryEntry[];

/** Whether a path is inside a root after resolution. */
export function isContained(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve an existing path and prove it stays inside an allowed root.
 * @param root The allowed root; it must exist.
 * @param candidate The path to resolve.
 * @returns The real path, or a refusal.
 */
export function containedRealPath(
    root: string,
    candidate: string,
): { ok: true; path: string } | { ok: false; problem: string } {
    if (!existsSync(candidate)) {
        return { ok: false, problem: `${candidate} does not exist` };
    }
    let realRoot: string;
    let realCandidate: string;
    try {
        realRoot = realpathSync(root);
        realCandidate = realpathSync(candidate);
    } catch (error) {
        return {
            ok: false,
            problem: `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (!isContained(realRoot, realCandidate)) {
        return {
            ok: false,
            problem: `${candidate} resolves outside ${root}`,
        };
    }
    return { ok: true, path: realCandidate };
}

/** The SHA-256 of one file's exact bytes. */
export function fileSha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Inventory a directory deterministically. Symlinks are followed only when
 * their resolved target stays inside the root; anything else is a refusal.
 * @param root The directory to inventory.
 * @returns The sorted inventory or the first unsafe path.
 */
export function inventory(
    root: string,
): { ok: true; entries: Inventory } | { ok: false; problem: string } {
    if (!existsSync(root)) {
        return { ok: false, problem: `${root} does not exist` };
    }
    const realRoot = realpathSync(root);
    const entries: Inventory = [];
    const walk = (directory: string): string | null => {
        for (const entry of readdirSync(directory, {
            withFileTypes: true,
        }).sort((left, right) => left.name.localeCompare(right.name))) {
            const path = join(directory, entry.name);
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) {
                const target = readlinkSync(path);
                const resolved = resolve(dirname(path), target);
                if (!isContained(realRoot, resolved)) {
                    return `${path} symlink escapes ${root}`;
                }
                const real = realpathSync(path);
                if (!isContained(realRoot, real)) {
                    return `${path} resolves outside ${root}`;
                }
                entries.push({
                    path: relative(realRoot, path).split(sep).join("/"),
                    sha256: fileSha256(real),
                    link: target,
                });
                continue;
            }
            if (stat.isDirectory()) {
                const problem = walk(path);
                if (problem !== null) return problem;
                continue;
            }
            if (!stat.isFile()) {
                return `${path} is not a regular file`;
            }
            entries.push({
                path: relative(realRoot, path).split(sep).join("/"),
                sha256: fileSha256(path),
            });
        }
        return null;
    };
    const problem = walk(realRoot);
    if (problem !== null) return { ok: false, problem };
    return {
        ok: true,
        entries: entries.sort((left, right) =>
            left.path.localeCompare(right.path),
        ),
    };
}

/**
 * Recheck an inventory against a directory.
 * @param root The directory to check.
 * @param expected The inventory that must still hold.
 * @returns The differences; empty means intact.
 */
export function inventoryDifferences(
    root: string,
    expected: Inventory,
): string[] {
    const observed = inventory(root);
    if (!observed.ok) return [observed.problem];
    const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
    const observedMap = new Map(
        observed.entries.map((entry) => [entry.path, entry]),
    );
    const problems: string[] = [];
    for (const [path, entry] of expectedMap) {
        const found = observedMap.get(path);
        if (found === undefined) problems.push(`missing ${path}`);
        else if (found.sha256 !== entry.sha256) {
            problems.push(`changed ${path}`);
        }
    }
    for (const path of observedMap.keys()) {
        if (!expectedMap.has(path)) problems.push(`added ${path}`);
    }
    return problems;
}

/**
 * Copy a source tree into a destination that must not already exist.
 * Symlinks are checked for containment and preserved as relative links.
 * @param source The source directory.
 * @param destination The destination directory.
 * @param include Optional top-level members to copy; all when omitted.
 * @returns Nothing, or the refusal that stopped the copy.
 */
export function stageTree(
    source: string,
    destination: string,
    include?: readonly string[],
): { ok: true } | { ok: false; problem: string } {
    const contained = containedRealPath(source, source);
    if (!contained.ok) return contained;
    const realSource = contained.path;
    if (existsSync(destination)) {
        return { ok: false, problem: `${destination} already exists` };
    }
    mkdirSync(destination, { recursive: true });
    const copied = new Set<string>();
    const copy = (from: string, to: string): string | null => {
        const stat = lstatSync(from);
        if (stat.isSymbolicLink()) {
            const target = readlinkSync(from);
            const resolved = resolve(dirname(from), target);
            if (!isContained(realSource, resolved)) {
                return `${from} symlink escapes ${realSource}`;
            }
            mkdirSync(dirname(to), { recursive: true });
            symlinkSync(target, to);
            return null;
        }
        if (stat.isDirectory()) {
            mkdirSync(to, { recursive: true });
            for (const entry of readdirSync(from, { withFileTypes: true }).sort(
                (left, right) => left.name.localeCompare(right.name),
            )) {
                const problem = copy(
                    join(from, entry.name),
                    join(to, entry.name),
                );
                if (problem !== null) return problem;
            }
            return null;
        }
        if (!stat.isFile()) return `${from} is not a regular file`;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        return null;
    };
    const members =
        include === undefined
            ? readdirSync(realSource, { withFileTypes: true })
                  .map((entry) => entry.name)
                  .sort()
            : [...include].sort();
    for (const member of members) {
        if (!copied.add(member)) {
            return { ok: false, problem: `duplicate include ${member}` };
        }
        const from = join(realSource, member);
        if (!existsSync(from)) {
            return { ok: false, problem: `${from} does not exist` };
        }
        const problem = copy(from, join(destination, member));
        if (problem !== null) return { ok: false, problem };
    }
    return { ok: true };
}
