import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    symlinkSync,
    copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathWithin } from "../evidence/paths.ts";

/** One file identity in an immutable inventory. */
export interface InventoryEntry {
    /** The path value. */
    path: string;
    /** The sha256 value; empty for an empty-directory entry. */
    sha256: string;
    /** The entry kind; absent legacy inventories describe regular files. */
    kind?: "file" | "symlink" | "directory";
    /** Present only for a contained symlink, recording its relative target. */
    link?: string;
    /**
     * Whether any execute bit is set. Present only in inventory version 2 for
     * regular files; absent legacy inventories keep version 1 semantics.
     */
    executable?: boolean;
}

/** A deterministic inventory of a directory tree. */
export type Inventory = InventoryEntry[];

/** The inventory formats this engine can read and write. */
export type InventoryVersion = 1 | 2;

/**
 * Whether a path is inside a root. Containment is compared by path
 * components, so a child named `..cache` stays contained and a sibling named
 * `root-archive` is never mistaken for `root`.
 * @param root The containing root.
 * @param path The candidate path.
 * @returns True when the path is the root or sits beneath it.
 */
export function isContained(root: string, path: string): boolean {
    return pathWithin(root, path);
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

/**
 * The SHA-256 of one regular file's exact bytes. The open is non-blocking and
 * no-follow, and the descriptor is checked before reading, so a FIFO or a
 * replacement object is refused instead of hanging or reading unexpectedly.
 * @param path The file path.
 * @returns The lower-case hex digest.
 */
export function fileSha256(path: string): string {
    let fd: number | null = null;
    try {
        fd = openSync(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        if (!fstatSync(fd).isFile()) {
            throw new Error(`${path} is not a regular file`);
        }
        return createHash("sha256").update(readFileSync(fd)).digest("hex");
    } finally {
        if (fd !== null) closeSync(fd);
    }
}

/** Inventory one contained symlink, or the controlled refusal. */
function symlinkEntry(
    realRoot: string,
    root: string,
    path: string,
): { ok: true; entry: InventoryEntry } | { ok: false; problem: string } {
    const target = readlinkSync(path);
    const resolved = resolve(dirname(path), target);
    if (!isContained(realRoot, resolved)) {
        return { ok: false, problem: `${path} symlink escapes ${root}` };
    }
    let real: string;
    try {
        real = realpathSync(path);
    } catch {
        return {
            ok: false,
            problem: `${path} is a dangling or unreadable symlink`,
        };
    }
    if (!isContained(realRoot, real)) {
        return { ok: false, problem: `${path} resolves outside ${root}` };
    }
    if (!lstatSync(real).isFile()) {
        return {
            ok: false,
            problem: `${path} resolves to a non-regular file`,
        };
    }
    try {
        return {
            ok: true,
            entry: {
                path: relative(realRoot, path).split(sep).join("/"),
                sha256: fileSha256(real),
                kind: "symlink",
                link: target,
            },
        };
    } catch (error) {
        return {
            ok: false,
            problem: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** The relative, forward-slash path for one inventory entry. */
function entryPath(realRoot: string, path: string): string {
    return relative(realRoot, path).split(sep).join("/");
}

/** Inventory one regular file, or the refusal. */
function fileEntry(
    path: string,
    realRoot: string,
    version: InventoryVersion,
): InventoryEntry | string {
    let digest: string;
    try {
        digest = fileSha256(path);
    } catch (error) {
        return `${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const stat = lstatSync(path);
    return {
        path: entryPath(realRoot, path),
        sha256: digest,
        kind: "file",
        ...(version === 2 ? { executable: (stat.mode & 0o111) !== 0 } : {}),
    };
}

/** One entry's contribution, or the refusal that stopped the walk. */
function walkEntry(options: {
    entries: Inventory;
    realRoot: string;
    root: string;
    path: string;
    version: InventoryVersion;
}): string | null {
    const stat = lstatSync(options.path);
    if (stat.isSymbolicLink()) {
        const linked = symlinkEntry(
            options.realRoot,
            options.root,
            options.path,
        );
        if (!linked.ok) return linked.problem;
        options.entries.push(linked.entry);
        return null;
    }
    if (stat.isDirectory()) return walk(options);
    if (!stat.isFile()) return `${options.path} is not a regular file`;
    const entry = fileEntry(options.path, options.realRoot, options.version);
    if (typeof entry === "string") return entry;
    options.entries.push(entry);
    return null;
}

/**
 * Inventory a directory deterministically. Symlinks are followed only when
 * their resolved target stays inside the root; anything else is a refusal.
 *
 * Version 2 records each regular file's execute bit and every empty directory,
 * both of which can change whether a staged payload still executes. Version 1
 * is the historical format and is what every existing manifest and frozen root
 * was written with: it records content only.
 * @param root The directory to inventory.
 * @param options The inventory format, defaulting to the historical version 1.
 * @returns The sorted inventory or the first unsafe path.
 */
export function inventory(
    root: string,
    options: { version?: InventoryVersion } = {},
): { ok: true; entries: Inventory } | { ok: false; problem: string } {
    const version = options.version ?? 1;
    if (!existsSync(root)) {
        return { ok: false, problem: `${root} does not exist` };
    }
    const entries: Inventory = [];
    const problem = walk({ entries, realRoot: realpathSync(root), root, version });
    if (problem !== null) return { ok: false, problem };
    return {
        ok: true,
        entries: entries.sort((left, right) =>
            left.path.localeCompare(right.path),
        ),
    };
}

/** Walk one directory, appending its entries. */
function walk(options: {
    entries: Inventory;
    realRoot: string;
    root: string;
    version: InventoryVersion;
    path?: string;
}): string | null {
    const directory = options.path ?? options.realRoot;
    const members = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
    );
    if (
        options.version === 2 &&
        members.length === 0 &&
        directory !== options.realRoot
    ) {
        options.entries.push({
            path: entryPath(options.realRoot, directory),
            sha256: "",
            kind: "directory",
        });
        return null;
    }
    for (const member of members) {
        const problem = walkEntry({
            ...options,
            path: join(directory, member.name),
        });
        if (problem !== null) return problem;
    }
    return null;
}

/** The kind a legacy entry describes when the field is absent. */
function kindOf(entry: InventoryEntry): "file" | "symlink" | "directory" {
    return entry.kind ?? (entry.link === undefined ? "file" : "symlink");
}

/**
 * Compare one path's identity: kind, link target, content bytes and, when the
 * frozen entry recorded it, the execute bit. A link retargeted to identical
 * bytes is still a change; an execute bit that was never recorded is not a
 * change, so historical inventories keep their original semantics.
 * @param path The relative path.
 * @param expected The frozen entry.
 * @param observed The current entry.
 * @returns Differences; empty means identical identity.
 */
export function inventoryEntryDifferences(
    path: string,
    expected: InventoryEntry,
    observed: InventoryEntry,
): string[] {
    const problems: string[] = [];
    const expectedKind = kindOf(expected);
    const observedKind = kindOf(observed);
    if (expectedKind !== observedKind) {
        problems.push(
            `changed kind ${path} (${expectedKind} -> ${observedKind})`,
        );
    }
    if ((expected.link ?? null) !== (observed.link ?? null)) {
        problems.push(
            `retargeted link ${path} (${expected.link ?? "(none)"} -> ${observed.link ?? "(none)"})`,
        );
    }
    if (expected.sha256 !== observed.sha256) {
        problems.push(`changed ${path}`);
    }
    const executable = executableProblem(path, expected, observed);
    if (executable !== null) problems.push(executable);
    return problems;
}

/** The execute-bit difference, when both sides recorded it. */
function executableProblem(
    path: string,
    expected: InventoryEntry,
    observed: InventoryEntry,
): string | null {
    if (
        expected.executable === undefined ||
        observed.executable === undefined ||
        expected.executable === observed.executable
    ) {
        return null;
    }
    return `changed executable bit ${path} (${expected.executable ? "on" : "off"} -> ${observed.executable ? "on" : "off"})`;
}

/**
 * Recheck an inventory against a directory.
 * @param root The directory to check.
 * @param expected The inventory that must still hold.
 * @param options The inventory format the expected entries use; a historical
 *   version 1 inventory keeps version 1 comparison semantics.
 * @returns The differences; empty means intact.
 */
export function inventoryDifferences(
    root: string,
    expected: Inventory,
    options: { version?: InventoryVersion } = {},
): string[] {
    if (!existsSync(root)) return ["directory is missing"];
    const observed = inventory(root, options);
    if (!observed.ok) return [observed.problem];
    const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
    const observedMap = new Map(
        observed.entries.map((entry) => [entry.path, entry]),
    );
    const problems: string[] = [];
    for (const [path, entry] of expectedMap) {
        const found = observedMap.get(path);
        if (found === undefined) problems.push(`missing ${path}`);
        else problems.push(...inventoryEntryDifferences(path, entry, found));
    }
    for (const path of observedMap.keys()) {
        if (!expectedMap.has(path)) problems.push(`added ${path}`);
    }
    return problems;
}

/**
 * The paths whose identity differs between two inventories, in sorted order.
 * @param before The earlier inventory.
 * @param after The later inventory.
 * @param ignored Paths excluded from the comparison.
 * @returns Changed, added and removed paths.
 */
export function changedInventoryPaths(
    before: Inventory,
    after: Inventory,
    ignored: readonly string[] = [],
): string[] {
    const skip = new Set(ignored);
    const beforeMap = new Map(before.map((entry) => [entry.path, entry]));
    const afterMap = new Map(after.map((entry) => [entry.path, entry]));
    const changed = new Set<string>();
    for (const [path, entry] of afterMap) {
        if (skip.has(path)) continue;
        const previous = beforeMap.get(path);
        if (
            previous === undefined ||
            inventoryEntryDifferences(path, previous, entry).length > 0
        ) {
            changed.add(path);
        }
    }
    for (const path of beforeMap.keys()) {
        if (!skip.has(path) && !afterMap.has(path)) changed.add(path);
    }
    return [...changed].sort();
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
        // Child processes execute staged scripts and plugins; the copy must
        // keep the executable bits that made the source runnable.
        chmodSync(to, stat.mode & 0o777);
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
