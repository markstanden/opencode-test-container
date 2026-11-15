/**
 * Installed-artifact proof.
 *
 * Packs the current checkout, installs the tarball into a temporary consumer
 * whose path contains a space, then runs the fresh docs lifecycle through the
 * installed `otc` binary. The scripted provider and campaign fixtures remain
 * development-only; the lifecycle under test is the installed artifact.
 */
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactSha256 } from "../src/contracts/version.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

/** Run one command and return its output. */
function run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = {},
) {
    return spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 300_000,
    });
}

/** SHA-256 of one file. */
function sha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Pack the checkout and install it into the consumer, proving version output. */
function packAndInstall(
    root: string,
    consumer: string,
): {
    binary: string;
    version: string;
    tarball: string;
    sha256: string;
    integrity: string | null;
} {
    mkdirSync(consumer, { recursive: true });
    cpSync(join(REPO, "package.json"), join(consumer, "package.json"));
    const packed = run(
        "npm",
        ["pack", "--json", "--pack-destination", root],
        REPO,
    );
    if (packed.status !== 0) throw new Error(packed.stderr);
    const parsed = JSON.parse(packed.stdout) as unknown;
    const entries = (
        Array.isArray(parsed) ? parsed : Object.values(parsed)
    ) as Array<{
        filename?: string;
        integrity?: string;
    }>;
    const filename = entries[0]?.filename;
    if (typeof filename !== "string") {
        throw new Error("npm pack did not name a tarball");
    }
    const tarball = join(root, filename);
    const installed = run(
        "npm",
        ["install", "--no-audit", "--no-fund", tarball],
        consumer,
    );
    if (installed.status !== 0) throw new Error(installed.stderr);
    const binary = join(consumer, "node_modules", ".bin", "otc");
    if (!existsSync(binary)) throw new Error("installed bin is missing");
    const version = run(binary, ["--version"], consumer);
    if (version.status !== 0) throw new Error(version.stderr);
    return {
        binary,
        version: version.stdout.trim(),
        tarball: filename,
        sha256: sha256(tarball),
        integrity: entries[0]?.integrity ?? null,
    };
}

/** Run the fresh docs lifecycle through one installed binary. */
function installedRehearsal(
    binary: string,
    work: string,
    consumer: string,
): { receipt: Record<string, unknown>; identity: Record<string, unknown> } {
    const rehearsal = run(
        process.execPath,
        [join(HERE, "fresh-docs.mts"), work],
        REPO,
        { OTC_CLI: binary, OTC_KEEP_REHEARSAL: "1" },
    );
    if (rehearsal.status !== 0) {
        throw new Error(
            `installed rehearsal failed:\n${rehearsal.stdout}\n${rehearsal.stderr}`,
        );
    }
    const receiptPath = join(work, "fresh-docs-rehearsal.json");
    if (!existsSync(receiptPath)) {
        throw new Error("installed rehearsal wrote no receipt");
    }
    const root = join(work, "campaign", "root");
    const frozen = JSON.parse(
        readFileSync(join(root, "prepare", "frozen.json"), "utf8"),
    ) as { tool: { version: string; artifactSha256: string } };
    const status = run(binary, ["status", "--root", root, "--json"], consumer);
    if (status.status !== 0) throw new Error(status.stderr);
    const statusTool = (
        JSON.parse(status.stdout) as {
            tool: { version: string; artifactSha256: string };
        }
    ).tool;
    const installedRoot = join(
        consumer,
        "node_modules",
        "@markstanden",
        "opencode-test-container",
    );
    const artifact = artifactSha256(installedRoot);
    if (frozen.tool.artifactSha256 !== artifact) {
        throw new Error("installed artifact hash does not match the freeze");
    }
    if (statusTool.artifactSha256 !== artifact) {
        throw new Error("status reports a different artifact hash");
    }
    return {
        receipt: JSON.parse(readFileSync(receiptPath, "utf8")) as Record<
            string,
            unknown
        >,
        identity: {
            frozen: frozen.tool,
            status: statusTool,
            artifact,
        },
    };
}

/** The main proof. */
function main(): void {
    const root = mkdtempSync(join(tmpdir(), "otc installed-"));
    const consumer = join(root, "consumer with spaces");
    const work = join(root, "rehearsal work");
    try {
        const installed = packAndInstall(root, consumer);
        const rehearsal = installedRehearsal(installed.binary, work, consumer);
        const proof = {
            schemaVersion: 1,
            consumer,
            installed,
            identity: rehearsal.identity,
            rehearsal: rehearsal.receipt,
        };
        writeFileSync(
            join(root, "installed-rehearsal.json"),
            `${JSON.stringify(proof, null, 2)}\n`,
            "utf8",
        );
        console.log(JSON.stringify(proof, null, 2));
    } finally {
        if (process.env.OTC_KEEP_REHEARSAL !== "1") {
            rmSync(root, { recursive: true, force: true });
        }
    }
}

try {
    main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
}
