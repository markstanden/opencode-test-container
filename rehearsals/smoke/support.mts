/**
 * Helpers for the real-container smoke suite.
 *
 * The suite drives the installed tarball's CLI and shipped adapters. It never
 * uses a provider credential: every model turn comes from a loopback scripted
 * server bound to an ephemeral port.
 */
import { spawn, spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    symlinkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const FIXTURES = join(HERE, "fixtures");

/** One child-process result. */
export interface ChildResult {
    /** The exit status, or null when the child was signalled. */
    status: number | null;
    /** Captured standard output. */
    stdout: string;
    /** Captured standard error. */
    stderr: string;
}

/** Run one command, bounded by a timeout, with an explicit environment. */
export function run(
    command: string,
    args: readonly string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        input?: string;
    } = {},
): ChildResult {
    const result = spawnSync(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 300_000,
        input: options.input,
        // The CLI must never wait on an inherited stdin pipe.
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** Run one command asynchronously, so an in-process provider can serve it. */
export function runAsync(
    command: string,
    args: readonly string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
    } = {},
): Promise<ChildResult> {
    return new Promise((resolvePromise) => {
        const child = spawn(command, [...args], {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) child.kill("SIGKILL");
        }, options.timeoutMs ?? 300_000);
        const finish = (status: number | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ status, stdout, stderr });
        };
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            stderr += error.message;
            finish(null);
        });
        child.on("close", (status) => finish(status));
    });
}

/** Run one command and require success. */
export function must(
    command: string,
    args: readonly string[],
    options: Parameters<typeof run>[2] = {},
): ChildResult {
    const result = run(command, args, options);
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${String(result.status)}): ${result.stderr.trim() || result.stdout.trim()}`,
        );
    }
    return result;
}

/** SHA-256 of one file. */
export function fileSha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Copy the packable package inputs into an isolated staging tree. */
export function stagePackage(): string {
    const stage = mkdtempSync(join(tmpdir(), "otc-smoke-pack-"));
    for (const input of [
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
    ]) {
        cpSync(join(REPO, input), join(stage, input), { recursive: true });
    }
    symlinkSync(join(REPO, "node_modules"), join(stage, "node_modules"));
    return stage;
}

/** Pack the staged package and return the tarball identity. */
export function pack(
    stage: string,
    destination: string,
): {
    tarball: string;
    sha256: string;
    version: string;
} {
    mkdirSync(destination, { recursive: true });
    const packed = must(
        "npm",
        ["pack", "--json", "--pack-destination", destination],
        { cwd: stage },
    );
    const parsed = JSON.parse(packed.stdout) as
        Array<{ filename: string }> | Record<string, { filename: string }>;
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const filename = entries[0]?.filename;
    if (filename === undefined) throw new Error("npm pack returned no tarball");
    const tarball = join(destination, filename);
    return {
        tarball,
        sha256: fileSha256(tarball),
        version: (
            JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as {
                version: string;
            }
        ).version,
    };
}

/** Install the tarball into a minimal consumer whose path contains a space. */
export function installConsumer(
    tarball: string,
    parent: string,
): { consumer: string; binary: string } {
    const consumer = join(parent, "consumer with space");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify(
            { name: "otc-smoke-consumer", private: true, version: "1.0.0" },
            null,
            2,
        )}\n`,
        "utf8",
    );
    must("npm", ["install", "--no-audit", "--no-fund", tarball], {
        cwd: consumer,
    });
    return {
        consumer,
        binary: join(consumer, "node_modules", ".bin", "otc"),
    };
}

/** Import one shipped module from the installed package. */
export async function installedModule<T>(
    consumer: string,
    relative: string,
): Promise<T> {
    const path = join(
        consumer,
        "node_modules",
        "@markstanden",
        "opencode-test-container",
        "dist",
        relative,
    );
    return (await import(pathToFileURL(path).href)) as T;
}

/** A unique tag for this run. */
export function uniqueTag(suffix: string): string {
    return `localhost/otc-smoke-${suffix}:${process.pid}-${Date.now().toString(36)}`;
}

/** One free host port, held open until the caller closes it. */
export async function heldPort(): Promise<{
    port: number;
    close: () => Promise<void>;
}> {
    const server = createNetServer();
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((done, fail) => {
        server.on("error", fail);
        server.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    const port =
        typeof address === "object" && address !== null ? address.port : 0;
    return {
        port,
        close: () =>
            new Promise((done) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => done());
            }),
    };
}

/** Write a campaign fixture with concrete values substituted. */
export function writeCampaign(options: {
    directory: string;
    image: string;
    opencodeVersion: string;
    baseUrl: string;
    timeoutMs: number;
}): string {
    mkdirSync(options.directory, { recursive: true });
    const campaign = JSON.parse(
        readFileSync(join(FIXTURES, "campaign.json"), "utf8"),
    ) as {
        runtime: {
            image: string;
            opencodeVersion: string;
            timeoutMs: number;
            provider: {
                overlay: {
                    providers: Record<
                        string,
                        { settings: { baseURL: string } }
                    >;
                };
            };
        };
    };
    campaign.runtime.image = options.image;
    campaign.runtime.opencodeVersion = options.opencodeVersion;
    campaign.runtime.timeoutMs = options.timeoutMs;
    campaign.runtime.provider.overlay.providers[
        "zai-coding-plan"
    ]!.settings.baseURL = options.baseUrl;
    const path = join(options.directory, "campaign.json");
    writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
    cpSync(join(FIXTURES, "suite.json"), join(options.directory, "suite.json"));
    for (const member of ["skills", "plugin", "workspace"]) {
        cpSync(join(FIXTURES, member), join(options.directory, member), {
            recursive: true,
        });
    }
    return path;
}

/** Read one JSON file. */
export function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** List files recursively, sorted. */
export function filesUnder(root: string): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else files.push(path);
        }
    };
    if (existsSync(root)) walk(root);
    return files.sort();
}

/** A scratch directory owned by this suite. */
export function scratch(): string {
    return mkdtempSync(join(tmpdir(), "otc-smoke-"));
}

/** Remove a directory without throwing. */
export function remove(path: string): void {
    rmSync(path, { recursive: true, force: true });
}

/** Run a script inside a container and parse its JSON stdout. */
export function parseProbe<T>(stdout: string): T {
    const line = stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("{"))
        .at(-1);
    if (line === undefined) throw new Error(`probe printed no JSON: ${stdout}`);
    return JSON.parse(line) as T;
}
