/**
 * Installed-package sharding proof.
 *
 * Runs the documented two-root recipe through the installed `otc` binary and
 * the shipped scripted provider: prepare and freeze the same nine-slot
 * campaign twice, run disjoint `--slot` selections, assess, close and analyse
 * each root, then merge the two reports with the installed `rates.mjs`.
 *
 * Every root's report lists the whole frozen schedule (unrun rows included),
 * so this proves the documented merge reconciles unrun duplicates, counts each
 * executed slot once and refuses two actual executions of one slot.
 *
 * Manual rehearsal, separate from `npm test`; real containers, zero paid calls.
 */
import { spawn, spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI = process.env.OTC_CLI ?? join(REPO, "dist", "cli", "otc.js");
const PKG = process.env.OTC_PKG ?? REPO;
const IMAGE = process.env.OTC_IMAGE ?? "localhost/otc-sandbox:2.2.6";
const SHARD_A = ["pos-r0", "unrelated-r0", "near-r0"];
const SHARD_B = [
    "pos-r1",
    "pos-r2",
    "unrelated-r1",
    "unrelated-r2",
    "near-r1",
    "near-r2",
];

/** One child result. */
interface ChildResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Fail the rehearsal with one readable message. */
function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`sharding rehearsal failed: ${message}`);
}

/** Run one command and capture its output. */
function run(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = {},
): ChildResult {
    const result = spawnSync(command, args, {
        cwd: dirname(CLI),
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 600_000,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** Run one installed CLI step, refusing a non-zero exit. */
function step(label: string, args: string[]): void {
    const result = run(CLI, args, { ZAI_API_KEY: "rehearsal" });
    expect(
        result.status === 0,
        `${label} failed: ${result.stderr || result.stdout}`,
    );
}

/** A free loopback port, released before the provider claims it. */
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done, fail) => {
        server.on("error", fail);
        server.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    const port =
        typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
}

/** Resolve the image to its immutable ID. */
function imageId(): string {
    const result = run("podman", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        IMAGE,
    ]);
    const raw = result.stdout.trim();
    expect(
        result.status === 0 && /^(sha256:)?[0-9a-f]{12,64}$/i.test(raw),
        `cannot inspect ${IMAGE}: ${result.stderr || raw}`,
    );
    return raw.startsWith("sha256:") ? raw : `sha256:${raw}`;
}

/** Copy the shipped repetitions campaign and point it at the rehearsal. */
function writeCampaign(
    source: string,
    destination: string,
    id: string,
    port: number,
): string {
    cpSync(source, destination, { recursive: true });
    const path = join(destination, "campaign-repetitions.json");
    const campaign = JSON.parse(readFileSync(path, "utf8")) as {
        runtime: {
            imageId?: string;
            provider: {
                overlay: {
                    providers: Record<string, { settings: { baseURL: string } }>;
                };
            };
        };
    };
    campaign.runtime.imageId = id;
    const providerId = Object.keys(
        campaign.runtime.provider.overlay.providers,
    )[0];
    expect(providerId !== undefined, "the campaign declares no provider overlay");
    campaign.runtime.provider.overlay.providers[providerId] = {
        settings: { baseURL: `http://127.0.0.1:${port}/v1` },
    };
    writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
    return path;
}

/** Start the shipped scripted provider and wait for readiness. */
async function startProvider(
    port: number,
): Promise<{
    close: () => void;
    chatRequests: () => Promise<number>;
}> {
    const server = join(PKG, "examples", "provider", "server.mjs");
    const plan = join(PKG, "examples", "skills", "provider-plan.json");
    expect(existsSync(server), `shipped provider is missing at ${server}`);
    const child = spawn(
        process.execPath,
        [server, "--port", String(port), "--plan", plan],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
        output += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        output += String(chunk);
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
        try {
            const health = await fetch(`http://127.0.0.1:${port}/health`);
            if (health.ok) break;
        } catch {
            // Not ready yet.
        }
        expect(Date.now() < deadline, `provider did not start: ${output}`);
        await new Promise((done) => setTimeout(done, 200));
    }
    return {
        close: () => {
            child.kill("SIGTERM");
        },
        chatRequests: async () => {
            const health = await fetch(`http://127.0.0.1:${port}/health`);
            const value = (await health.json()) as { chatRequests?: unknown };
            return typeof value.chatRequests === "number"
                ? value.chatRequests
                : 0;
        },
    };
}

/** Analyse one root and return its report. */
function analyse(root: string, out: string): Record<string, unknown> {
    step("analyse", ["analyse", "--root", root, "--out", out]);
    return JSON.parse(
        readFileSync(join(out, "report.json"), "utf8"),
    ) as Record<string, unknown>;
}

/** Run one shard: prepare, freeze, run its slots, assess, close, analyse. */
function shard(
    work: string,
    name: string,
    campaign: string,
    slots: readonly string[],
): { root: string; report: Record<string, unknown> } {
    const root = join(work, name, "root");
    step("prepare", ["prepare", "--campaign", campaign, "--root", root]);
    step("freeze", ["freeze", "--root", root]);
    step("run", ["run", "--root", root, "--slot", slots.join(",")]);
    step("assess", ["assess", "--root", root]);
    step("close", ["close", "--root", root]);
    const report = analyse(root, join(work, name, "report"));
    return { root, report };
}

/** The main proof. */
async function main(): Promise<void> {
    const work =
        process.argv[2] ?? mkdtempSync(join(tmpdir(), "otc-sharding-"));
    mkdirSync(work, { recursive: true });
    const id = imageId();
    const port = await freePort();
    const campaignDir = join(work, "campaign");
    const campaign = writeCampaign(
        join(PKG, "examples", "skills"),
        campaignDir,
        id,
        port,
    );
    const provider = await startProvider(port);
    try {
        const first = shard(work, "shard-a", campaign, SHARD_A);
        const second = shard(work, "shard-b", campaign, SHARD_B);
        const slotsOf = (report: Record<string, unknown>) =>
            (report.slots ?? []) as Array<Record<string, unknown>>;
        expect(
            slotsOf(first.report).length === 9,
            "shard A did not list the whole schedule",
        );
        expect(
            slotsOf(second.report).length === 9,
            "shard B did not list the whole schedule",
        );
        expect(
            slotsOf(first.report).filter(
                (slot) => slot.validity !== "unrun",
            ).length === SHARD_A.length,
            "shard A executed the wrong number of slots",
        );
        expect(
            slotsOf(second.report).filter(
                (slot) => slot.validity !== "unrun",
            ).length === SHARD_B.length,
            "shard B executed the wrong number of slots",
        );

        const rates = join(
            PKG,
            "examples",
            "reporting",
            "rates.mjs",
        );
        const merged = run(
            process.execPath,
            [
                rates,
                join(work, "shard-a", "report", "report.json"),
                join(work, "shard-b", "report", "report.json"),
            ],
        );
        expect(
            merged.status === 0,
            `merged rates failed: ${merged.stderr || merged.stdout}`,
        );
        expect(
            /\| positive-instrument \| skill-only \| activation \| 3\/3 \| 3\/3 \| 3\/3 \| 0 \| 0 \| 0 \|/.test(
                merged.stdout,
            ),
            `positive row is not 3/3 in:\n${merged.stdout}`,
        );
        expect(
            /\| negative-near-miss \| skill-only \| no-activation \| 3\/3 \| 0\/3 \| 3\/3 \| 0 \| 0 \| 0 \|/.test(
                merged.stdout,
            ),
            `near-miss row is not 3/3 in:\n${merged.stdout}`,
        );
        expect(
            /\| negative-unrelated \| skill-only \| no-activation \| 3\/3 \| 0\/3 \| 3\/3 \| 0 \| 0 \| 0 \|/.test(
                merged.stdout,
            ),
            `unrelated row is not 3/3 in:\n${merged.stdout}`,
        );

        // Two executions of one shard are a contradiction, even with the same
        // root: the merge must refuse rather than double the denominator.
        const duplicate = run(process.execPath, [
            rates,
            join(work, "shard-a", "report", "report.json"),
            join(work, "shard-a", "report", "report.json"),
        ]);
        expect(
            duplicate.status === 2 &&
                /executed in more than one shard/.test(duplicate.stderr),
            `duplicate shards were not refused: ${duplicate.stderr}`,
        );
        const chatRequests = await provider.chatRequests();
        expect(
            chatRequests > 0,
            "the scripted provider served no request",
        );

        const receipt = {
            schemaVersion: 1,
            image: IMAGE,
            imageId: id,
            shards: {
                a: { slots: SHARD_A, executed: SHARD_A.length },
                b: { slots: SHARD_B, executed: SHARD_B.length },
            },
            perRootSlots: [
                slotsOf(first.report).length,
                slotsOf(second.report).length,
            ],
            mergedSlotRows: 9,
            mergedRates: merged.stdout,
            duplicateRefused: duplicate.stderr.trim(),
            providerChatRequests: chatRequests,
            work,
        };
        writeFileSync(
            join(work, "sharding-receipt.json"),
            `${JSON.stringify(receipt, null, 2)}\n`,
            "utf8",
        );
        console.log(JSON.stringify(receipt, null, 2));
    } finally {
        provider.close();
    }
}

try {
    await main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
}
