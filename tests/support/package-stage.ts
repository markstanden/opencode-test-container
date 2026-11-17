/**
 * Test-owned package staging.
 *
 * `npm pack` runs `prepack`, which deletes and rebuilds `dist/`. Packing the
 * working checkout therefore mutates shared build output while other test
 * files read it. Tests that need a real tarball stage the packable inputs in
 * their own temporary tree, link the repository's installed tooling, and run
 * the lifecycle there; the checkout's `dist/` stays untouched.
 */
import { cpSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inputs `npm pack` and `prepack` need, relative to the repository root. */
const PACKAGE_INPUTS = [
    "package.json",
    "package-lock.json",
    "src",
    "tsconfig.json",
    "tsconfig.build.json",
    "container",
    "examples",
    "docs",
    "README.md",
    "LICENSE",
];

/**
 * Copy the packable repository inputs into an isolated staging tree.
 * @param repo The repository root.
 * @returns The staging directory, owned by the caller.
 */
export function stagePackageInputs(repo: string): string {
    const stage = mkdtempSync(join(tmpdir(), "otc-pack-"));
    for (const input of PACKAGE_INPUTS) {
        cpSync(join(repo, input), join(stage, input), { recursive: true });
    }
    symlinkSync(join(repo, "node_modules"), join(stage, "node_modules"));
    return stage;
}
