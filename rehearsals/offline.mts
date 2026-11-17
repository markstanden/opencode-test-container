/**
 * Offline real-adapter rehearsal.
 *
 * Real Podman image, real OpenCode CLI and the real docs plugin, with a
 * scripted loopback provider. No real provider key and no paid call is used:
 * every completion comes from the scripted server. This is a manual command,
 * separate from `npm test`.
 *
 * Usage: node rehearsals/offline.mts [work-dir]
 * Environment:
 *   OTC_IMAGE                  image to pin (default localhost/opencode-placement-trials:latest)
 *   OTC_DOCS_PLUGIN            docs plugin checkout (default ../opencode-docs-plugin)
 *   OTC_KEEP_REHEARSAL=1       keep the work directory
 */
import { spawn, spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProvider, type ScriptedResponse } from "./provider.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI = join(REPO, "dist", "cli", "otc.js");
const IMAGE =
    process.env.OTC_IMAGE ?? "localhost/opencode-placement-trials:latest";
const DOCS_PLUGIN = resolve(
    process.env.OTC_DOCS_PLUGIN ?? join(REPO, "..", "opencode-docs-plugin"),
);

/** One child result. */
interface ChildResult {
    status: number | null;
    stdout: string;
    stderr: string;
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

/** Run the built CLI in a child process. */
function otc(
    args: string[],
    env: NodeJS.ProcessEnv = {},
): Promise<ChildResult> {
    return new Promise((done) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: dirname(CLI),
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
        child.on("close", (status) => done({ status, stdout, stderr }));
    });
}

/** Run Podman and return its stdout, refusing a non-zero exit. */
function podman(args: string[]): string {
    const result = spawnSync("podman", args, { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`podman ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

/** Copy a fixture tree into the rehearsal workspace. */
function copyFixture(source: string, target: string): void {
    cpSync(source, target, { recursive: true });
}

/** Write a campaign JSON file with the resolved image and provider port. */
function writeCampaign(
    path: string,
    options: {
        imageId: string;
        port: number;
        pluginPath?: string;
    },
): void {
    const campaign = JSON.parse(readFileSync(path, "utf8")) as {
        runtime: {
            imageId?: string;
            provider: {
                overlay: {
                    providers: Record<
                        string,
                        { settings: { baseURL: string } }
                    >;
                };
            };
        };
        subjects: Array<{ plugins?: Array<{ path: string }> }>;
    };
    campaign.runtime.imageId = options.imageId;
    campaign.runtime.provider.overlay.providers["zai-coding-plan"] = {
        settings: { baseURL: `http://127.0.0.1:${options.port}/v1` },
    };
    if (options.pluginPath !== undefined) {
        for (const subject of campaign.subjects) {
            for (const plugin of subject.plugins ?? []) {
                plugin.path = options.pluginPath;
            }
        }
    }
    writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
}

/** One rehearsed slot. */
interface SlotResult {
    slotId: string;
    plan: ScriptedResponse[];
    exit: number | null;
    chatRequests: number;
    otherRequests: number;
    meta: Record<string, unknown> | null;
    assessment: Record<string, unknown> | null;
}

/** Read a JSON record, or null. */
function json(path: string): Record<string, unknown> | null {
    if (!existsSync(path)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        return typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Run one slot with its own provider plan.
 * @param root The frozen campaign root.
 * @param slotId The selected slot.
 * @param plan The scripted provider responses.
 * @param port The loopback port.
 * @returns The observed result.
 */
async function runSlot(
    root: string,
    slotId: string,
    plan: ScriptedResponse[],
    port: number,
): Promise<SlotResult> {
    const provider = await startProvider(port, plan);
    try {
        const run = await otc(["run", "--root", root, "--slot", slotId], {
            ZAI_API_KEY: "rehearsal",
        });
        const trial = join(root, "evidence", "trials", slotId);
        return {
            slotId,
            plan,
            exit: run.status,
            chatRequests: provider.chatCount(),
            otherRequests: provider.otherCount(),
            meta: json(join(trial, "meta.json")),
            assessment: json(
                join(root, "evidence", "assessments", `${slotId}.json`),
            ),
        };
    } finally {
        await provider.close();
    }
}

/** Fail the rehearsal with one readable message. */
function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`rehearsal assertion failed: ${message}`);
}

/** Assert one slot's assessed outcome. */
function expectOutcome(
    result: SlotResult,
    outcome: string,
    validity: string,
    observed?: string,
): void {
    const assessment = result.assessment;
    expect(assessment !== null, `${result.slotId} has no assessment`);
    expect(
        assessment.outcome === outcome,
        `${result.slotId} outcome ${String(assessment.outcome)} != ${outcome}: ${JSON.stringify(assessment.reasons)}`,
    );
    expect(
        assessment.validity === validity,
        `${result.slotId} validity ${String(assessment.validity)} != ${validity}`,
    );
    if (observed !== undefined) {
        expect(
            assessment.observed === observed,
            `${result.slotId} observed ${String(assessment.observed)} != ${observed}`,
        );
    }
}

/** Concatenate every regular file's text under a directory. */
function textUnder(root: string): string {
    if (!existsSync(root)) return "";
    const chunks: string[] = [];
    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.isFile()) chunks.push(readFileSync(path, "utf8"));
        }
    };
    walk(root);
    return chunks.join("\n");
}

/** Prove the trial payload does not expose truth or another slot. */
function isolationChecks(root: string, slotId: string): string[] {
    const trial = join(root, "evidence", "trials", slotId);
    const problems: string[] = [];
    for (const forbidden of [
        "suite.json",
        "campaign.json",
        "manifest.json",
        "frozen.json",
    ]) {
        for (const candidate of [
            join(trial, "workspace", forbidden),
            join(trial, "config-home", forbidden),
        ]) {
            if (existsSync(candidate)) {
                problems.push(`${slotId} exposes ${candidate}`);
            }
        }
    }
    if (textUnder(join(trial, "workspace")).includes("expectedDocs")) {
        problems.push(`${slotId} workspace contains hidden criteria`);
    }
    if (textUnder(join(trial, "config-home")).includes("expectedDocs")) {
        problems.push(`${slotId} config home contains hidden criteria`);
    }
    return problems;
}

/** The main rehearsal. */
/** Run the skill-only rehearsal and assert every observation. */
async function runSkillRehearsal(
    work: string,
    imageId: string,
): Promise<SlotResult[]> {
    const skillRoot = join(work, "skills");
    copyFixture(join(HERE, "fixtures", "skills"), skillRoot);
    const skillPort = await freePort();
    writeCampaign(join(skillRoot, "campaign.json"), {
        imageId,
        port: skillPort,
    });
    const prepared = await otc([
        "prepare",
        "--campaign",
        join(skillRoot, "campaign.json"),
        "--root",
        join(skillRoot, "root"),
    ]);
    expect(prepared.status === 0, `skill prepare failed: ${prepared.stderr}`);
    const frozen = await otc(["freeze", "--root", join(skillRoot, "root")]);
    expect(frozen.status === 0, `skill freeze failed: ${frozen.stderr}`);

    const plans: Record<string, ScriptedResponse[]> = {
        positive: [
            {
                kind: "tool",
                tool: "skill",
                args: { id: "otel-helper" },
                id: "call_positive",
            },
            { kind: "text", content: "Instrumented the checkout service." },
        ],
        negative: [{ kind: "text", content: "Renamed the variable." }],
        "wrong-skill": [
            {
                kind: "tool",
                tool: "skill",
                args: { id: "other-skill" },
                id: "call_wrong",
            },
            { kind: "text", content: "Prepared the release checklist." },
        ],
        "failed-load": [
            {
                kind: "tool",
                tool: "skill",
                args: { id: "missing-skill" },
                id: "call_failed",
            },
            { kind: "text", content: "The helper was unavailable." },
        ],
        "invalid-capture": [{ kind: "truncate", content: "partial answer" }],
    };
    const skillResults: SlotResult[] = [];
    for (const slotId of Object.keys(plans)) {
        const result = await runSlot(
            join(skillRoot, "root"),
            slotId,
            plans[slotId] ?? [],
            skillPort,
        );
        skillResults.push(result);
    }
    const assessed = await otc(["assess", "--root", join(skillRoot, "root")]);
    expect(assessed.status === 0, `skill assess failed: ${assessed.stderr}`);
    // Re-read assessments after assessment.
    for (const result of skillResults) {
        result.assessment = json(
            join(
                skillRoot,
                "root",
                "evidence",
                "assessments",
                `${result.slotId}.json`,
            ),
        );
    }
    expectOutcome(
        skillResults[0] as SlotResult,
        "pass",
        "valid",
        "target-activation",
    );
    expectOutcome(
        skillResults[1] as SlotResult,
        "pass",
        "valid",
        "no-invocation",
    );
    expectOutcome(
        skillResults[2] as SlotResult,
        "pass",
        "valid",
        "other-skill-only",
    );
    expectOutcome(
        skillResults[3] as SlotResult,
        "unknown",
        "unknown",
        "failed-target-load",
    );
    expectOutcome(skillResults[4] as SlotResult, "unknown", "invalid");
    for (const result of skillResults) {
        expect(
            result.chatRequests > 0,
            `${result.slotId} made no provider request`,
        );
        expect(
            result.otherRequests === 0,
            `${result.slotId} made a readiness probe`,
        );
    }
    for (const result of skillResults) {
        const problems = isolationChecks(
            join(skillRoot, "root"),
            result.slotId,
        );
        expect(problems.length === 0, problems.join("; "));
    }
    const closedSkills = await otc([
        "close",
        "--root",
        join(skillRoot, "root"),
    ]);
    expect(
        closedSkills.status === 0,
        `skill close failed: ${closedSkills.stderr}`,
    );
    const analysedSkills = await otc([
        "analyse",
        "--root",
        join(skillRoot, "root"),
        "--out",
        join(skillRoot, "report"),
    ]);
    expect(
        analysedSkills.status === 0,
        `skill analysis failed: ${analysedSkills.stderr}`,
    );

    return skillResults;
}

/** Run the docs rehearsal and assert the signed-journal outcomes. */
async function runDocsRehearsal(
    work: string,
    imageId: string,
): Promise<SlotResult[]> {
    // Docs: the real plugin, a signed journal and a refused write.
    expect(
        existsSync(join(DOCS_PLUGIN, "package.json")),
        `docs plugin missing at ${DOCS_PLUGIN}`,
    );
    const docsRoot = join(work, "docs");
    copyFixture(join(HERE, "fixtures", "docs"), docsRoot);
    const docsPort = await freePort();
    writeCampaign(join(docsRoot, "campaign.json"), {
        imageId,
        port: docsPort,
        pluginPath: DOCS_PLUGIN,
    });
    const docsPrepared = await otc([
        "prepare",
        "--campaign",
        join(docsRoot, "campaign.json"),
        "--root",
        join(docsRoot, "root"),
    ]);
    expect(
        docsPrepared.status === 0,
        `docs prepare failed: ${docsPrepared.stderr}`,
    );
    const docsFrozen = await otc(["freeze", "--root", join(docsRoot, "root")]);
    expect(docsFrozen.status === 0, `docs freeze failed: ${docsFrozen.stderr}`);
    const docsPlans: Record<string, ScriptedResponse[]> = {
        "useful-write": [
            {
                kind: "tool",
                tool: "docs",
                args: {
                    add: {
                        mode: "create",
                        path: "notes/otel.md",
                        metadata: {
                            Area: "rehearsal",
                            Keywords: ["otel"],
                            Summary: "Span naming convention",
                        },
                        body: "# OpenTelemetry note\n\n## Facts\n\n- Name spans after the operation.\n",
                    },
                },
                id: "call_docs_write",
            },
            { kind: "text", content: "Recorded the convention." },
        ],
        "gate-blocked": [
            {
                kind: "tool",
                tool: "docs",
                args: {
                    add: {
                        mode: "create",
                        path: "notes/blocked.md",
                        metadata: {
                            Area: "rehearsal",
                            Keywords: ["otel"],
                            Summary: "",
                        },
                        body: "# Blocked note\n\n## Facts\n\n- Must not be written.\n",
                    },
                    lake: "repo",
                },
                id: "call_docs_blocked",
            },
            { kind: "text", content: "The write was refused." },
        ],
    };
    const docsResults: SlotResult[] = [];
    for (const slotId of Object.keys(docsPlans)) {
        docsResults.push(
            await runSlot(
                join(docsRoot, "root"),
                slotId,
                docsPlans[slotId] ?? [],
                docsPort,
            ),
        );
    }
    const docsAssessed = await otc([
        "assess",
        "--root",
        join(docsRoot, "root"),
    ]);
    expect(
        docsAssessed.status === 0,
        `docs assess failed: ${docsAssessed.stderr}`,
    );
    for (const result of docsResults) {
        result.assessment = json(
            join(
                docsRoot,
                "root",
                "evidence",
                "assessments",
                `${result.slotId}.json`,
            ),
        );
    }
    expectOutcome(docsResults[0] as SlotResult, "pass", "valid");
    expectOutcome(docsResults[1] as SlotResult, "pass", "valid");
    const blocked = docsResults[1]?.assessment;
    expect(
        blocked !== null && blocked !== undefined,
        "blocked assessment missing",
    );
    const blockedCounts = blocked.counts as Record<string, number>;
    expect(
        blockedCounts.creditedWrites === 0,
        "refused write earned recording credit",
    );
    expect(
        (blockedCounts.attemptedWrites ?? 0) >= 1,
        "refused write was not counted as attempted",
    );
    const closedDocs = await otc(["close", "--root", join(docsRoot, "root")]);
    expect(closedDocs.status === 0, `docs close failed: ${closedDocs.stderr}`);
    const analysedDocs = await otc([
        "analyse",
        "--root",
        join(docsRoot, "root"),
        "--out",
        join(docsRoot, "report"),
    ]);
    expect(
        analysedDocs.status === 0,
        `docs analysis failed: ${analysedDocs.stderr}`,
    );

    return docsResults;
}

async function main(): Promise<void> {
    const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), "otc-offline-"));
    mkdirSync(work, { recursive: true });
    const imageId = podman(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    const version = podman([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "opencode",
        IMAGE,
        "--version",
    ]);
    expect(version.includes("2.2.6"), `unexpected OpenCode version ${version}`);
    const skillResults = await runSkillRehearsal(work, imageId);
    const docsResults = await runDocsRehearsal(work, imageId);
    const totalChat = [...skillResults, ...docsResults].reduce(
        (sum, result) => sum + result.chatRequests,
        0,
    );
    const totalOther = [...skillResults, ...docsResults].reduce(
        (sum, result) => sum + result.otherRequests,
        0,
    );
    const report = {
        schemaVersion: 1,
        image: { tag: IMAGE, id: imageId, opencodeVersion: version.trim() },
        paidProviderCalls: 0,
        scriptedProvider: {
            chatRequests: totalChat,
            readinessRequests: totalOther,
        },
        skills: skillResults.map((result) => ({
            slotId: result.slotId,
            exit: result.exit,
            chatRequests: result.chatRequests,
            validity: result.assessment?.validity ?? null,
            observed: result.assessment?.observed ?? null,
            outcome: result.assessment?.outcome ?? null,
        })),
        docs: docsResults.map((result) => ({
            slotId: result.slotId,
            exit: result.exit,
            chatRequests: result.chatRequests,
            validity: result.assessment?.validity ?? null,
            outcome: result.assessment?.outcome ?? null,
            counts: result.assessment?.counts ?? null,
        })),
        work,
    };
    writeFileSync(
        join(work, "rehearsal.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
    );
    console.log(JSON.stringify(report, null, 2));
    if (process.env.OTC_KEEP_REHEARSAL !== "1") {
        rmSync(work, { recursive: true, force: true });
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
