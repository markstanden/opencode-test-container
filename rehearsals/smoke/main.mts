/**
 * Core real-container smoke suite (S01-S12).
 *
 * Runs the installed tarball's CLI and shipped adapters against a fresh image
 * built from the packaged Containerfile. A loopback scripted provider serves
 * every model turn; no real credential is read and no paid request is made.
 *
 * This command is deliberately separate from `npm test`: ordinary tests stay
 * hermetic, while this one requires rootless Podman.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import { startProvider, type ScriptedResponse } from "../provider.mts";
import {
    FIXTURES,
    REPO,
    fileSha256,
    runAsync,
    filesUnder,
    heldPort,
    installConsumer,
    installedModule,
    must,
    pack,
    parseProbe,
    readJson,
    remove,
    run,
    scratch,
    stagePackage,
    uniqueTag,
    writeCampaign,
    type ChildResult,
} from "./support.mts";

/** One recorded case result. */
interface CaseResult {
    id: string;
    name: string;
    ok: boolean;
    detail: string;
}

const results: CaseResult[] = [];
const ownedContainers: string[] = [];
const retain = process.env.OTC_SMOKE_RETAIN === "1";
const work = scratch();
const receipt: Record<string, unknown> = {
    suite: "otc-smoke",
    startedAt: new Date().toISOString(),
};

/** Record one case outcome. */
function record(id: string, name: string, ok: boolean, detail: string): void {
    results.push({ id, name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}: ${detail}`);
}

/** Assert one condition inside a case. */
function expect(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
}

/** Run one CLI command asynchronously so a scripted provider can serve it. */
function otc(
    env: NodeJS.ProcessEnv,
    binary: string,
    args: readonly string[],
    cwd: string,
): Promise<ChildResult> {
    return runAsync(binary, args, { cwd, env, timeoutMs: 300_000 });
}

/** Require a CLI success and return its output. */
async function otcMust(
    env: NodeJS.ProcessEnv,
    binary: string,
    args: readonly string[],
    cwd: string,
): Promise<ChildResult> {
    const result = await otc(env, binary, args, cwd);
    if (result.status !== 0) {
        throw new Error(
            `otc ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
        );
    }
    return result;
}

/** The isolated environment for the installed CLI. */
function cliEnv(home: string, containerData: string): NodeJS.ProcessEnv {
    return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        // Podman rootless keeps its image store under XDG_DATA_HOME. The CLI
        // child and this suite therefore share one suite-owned store, isolated
        // from the host's, so the built image is visible without touching the
        // operator's container storage.
        XDG_DATA_HOME: containerData,
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
        ZAI_API_KEY: "smoke-dummy-not-a-real-key",
        LANG: "C.UTF-8",
        TERM: "dumb",
        OTC_PRINT_LOGS: process.env.OTC_SMOKE_LOGS === "1" ? "1" : "0",
    };
}

/** A one-shot provider plan. */
async function provider(
    plan: readonly ScriptedResponse[],
    repeatLast = false,
): Promise<Awaited<ReturnType<typeof startProvider>>> {
    return startProvider(0, plan, { repeatLast });
}

/** Probe script: trial filesystem/identity policy. */
const FS_PROBE = `
import { writeFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
const out = { uid: process.getuid?.(), gid: process.getgid?.(), writes: {}, caps: null, noNewPrivs: null };
for (const [name, path] of [["workspace", "/workspace/probe-write.txt"], ["tmp", "/tmp/probe-write.txt"], ["subjects", "/subjects/probe-write.txt"], ["config", "/config-home/probe-write.txt"], ["root", "/probe-write.txt"]]) {
  try { writeFileSync(path, "x"); out.writes[name] = "ok"; } catch (error) { out.writes[name] = "denied"; }
}
try { out.caps = readFileSync("/proc/self/status", "utf8").split("\\n").find((line) => line.startsWith("CapEff:"))?.split(":")[1]?.trim(); } catch {}
try { out.noNewPrivs = readFileSync("/proc/self/status", "utf8").split("\\n").find((line) => line.startsWith("NoNewPrivs:"))?.split(":")[1]?.trim(); } catch {}
console.log(JSON.stringify(out));
`;

/** Probe script: host isolation with a control mount. */
const HOST_PROBE = `
import { readFileSync } from "node:fs";
const out = {};
for (const [name, path] of [["hostSentinel", process.env.HOST_SENTINEL ?? ""], ["mountedSentinel", "/control/sentinel.txt"]]) {
  try { out[name] = readFileSync(path, "utf8").trim(); } catch { out[name] = "denied"; }
}
console.log(JSON.stringify(out));
`;

/** Probe script: connect attempts to a host listener. */
const NET_PROBE = `
import { connect } from "node:net";
const port = Number(process.env.PROBE_PORT);
const hosts = ["127.0.0.1"];
const results = {};
for (const host of hosts) {
  results[host] = await new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 1200);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
    socket.on("error", () => { clearTimeout(timer); resolve("refused"); });
  });
}
console.log(JSON.stringify(results));
`;

/** Probe script: judge boundary. */
const JUDGE_PROBE = `
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const out = {
  packetReadable: (() => { try { return readFileSync("/judge/packet.md", "utf8").length > 0; } catch { return false; } })(),
  workWritable: (() => { try { writeFileSync("/judge/work/probe.txt", "x"); return true; } catch { return false; } })(),
  configWritable: (() => { try { writeFileSync("/config-home/probe.txt", "x"); return true; } catch { return false; } })(),
  packetWritable: (() => { try { writeFileSync("/judge/packet.md", "x"); return true; } catch { return false; } })(),
  subjectsVisible: (() => { try { readdirSync("/subjects"); return true; } catch { return false; } })(),
  evidenceVisible: (() => { try { readdirSync("/evidence"); return true; } catch { return false; } })(),
  journalKeyPresent: process.env.DOCS_OPERATION_JOURNAL_KEY !== undefined,
};
console.log(JSON.stringify(out));
`;

/** Run one probe in a real container using a production plan. */
async function probe(
    runContainer: (plan: unknown) => Promise<unknown>,
    plan: Record<string, unknown>,
    containerPath: string,
    extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    const containerPlan = {
        ...plan,
        ...extra,
        argv: ["node", containerPath],
    };
    const result = (await runContainer(containerPlan)) as {
        status: number | null;
        stdout: string;
        stderr: string;
        error: string | null;
        timedOut: boolean;
    };
    if (result.status !== 0) {
        throw new Error(
            `probe failed (${String(result.status)}): ${result.stderr || result.error || ""}`,
        );
    }
    return parseProbe(result.stdout);
}

/** Run one case, recording its outcome and never aborting the suite. */
const wanted = process.env.OTC_SMOKE_CASES?.split(",").map((id) => id.trim());

/** Run one case only when the optional selector includes it. */
async function testCase(
    id: string,
    name: string,
    body: () => Promise<string>,
): Promise<void> {
    if (wanted !== undefined && !wanted.includes(id)) return;
    console.log(`START ${id}`);
    try {
        record(
            id,
            name,
            true,
            await Promise.race([
                body(),
                new Promise<string>((_, reject) =>
                    setTimeout(
                        () => reject(new Error("case exceeded its 180s bound")),
                        180_000,
                    ),
                ),
            ]),
        );
    } catch (error) {
        record(
            id,
            name,
            false,
            error instanceof Error ? error.message : String(error),
        );
    }
}

// ---------------------------------------------------------------------------
// Shared setup: pack, install, build one image.
// ---------------------------------------------------------------------------

let binary = "";
let consumer = "";
let env: NodeJS.ProcessEnv = {};
let imageTag = "";
let imageId = "";
const opencodeVersion = "2.2.6";
let installed: {
    buildImage: (options: {
        tag: string;
        nodeBase: string;
        opencodeVersion: string;
    }) => Promise<{ status: number | null; stderr: string }>;
    resolveImage: (
        image: string,
        version: string,
    ) => Promise<
        | { ok: true; image: { imageId: string; opencodeVersion: string } }
        | { ok: false; problem: string }
    >;
    runContainer: (plan: unknown) => Promise<unknown>;
    containerArgv: (plan: unknown) => string[];
    planTrial: (options: Record<string, unknown>) => {
        ok: boolean;
        problems?: string[];
        plan?: Record<string, unknown>;
    };
    loadPreparedManifest: (root: string) => {
        ok: boolean;
        manifest?: PreparedManifest;
    };
    loadFrozen: (root: string) => {
        ok: boolean;
        record?: { imageId: string; tool: Record<string, unknown> };
    };
    decodeTrail: (text: string) => {
        calls: Array<{ tool: string; output: string }>;
    };
    readContainedFile: (
        root: string,
        path: string,
    ) => { ok: boolean; problem?: string };
    readPrimaryCheck: (
        trialDir: string,
    ) => { status: string; exit: number | null; stdout: string } | null;
    assessCampaign: (
        root: string,
        options?: Record<string, unknown>,
    ) => {
        ok: boolean;
        summary: Record<string, number>;
        problems: string[];
        skipped: string[];
    };
    closeCampaign: (root: string) => { ok: boolean; problems?: string[] };
    statusOf: (root: string) => {
        state: string;
        problems: string[];
        counts: Record<string, number>;
    };
    analyseCampaign: (
        root: string,
        out: string,
    ) => { ok: boolean; problems?: string[] };
    judgeSandboxPlanForSlot: (
        root: string,
        slotId: string,
        attemptId: string,
    ) => { ok: boolean; plan?: Record<string, unknown>; problems?: string[] };
};
interface PreparedManifest {
    campaignId: string;
    campaign: {
        schedule: { slots: Array<{ slotId: string; caseId: string }> };
    };
    suite: { cases: Array<{ caseId: string }> };
    subjects: Array<{ armId: string }>;
}

async function setup(): Promise<void> {
    const stage = stagePackage();
    const tarball = pack(stage, join(work, "tarball"));
    const installedConsumer = installConsumer(tarball.tarball, work);
    binary = installedConsumer.binary;
    consumer = installedConsumer.consumer;
    const containerData =
        process.env.OTC_SMOKE_CONTAINER_DATA ?? join(work, "container-data");
    mkdirSync(containerData, { recursive: true });
    process.env.XDG_DATA_HOME = containerData;
    env = cliEnv(join(work, "home"), containerData);
    imageTag = uniqueTag("image");

    const adapters = await installedModule<typeof installed>(
        consumer,
        "adapters/podman/image.js",
    );
    const runtime = await installedModule<typeof installed>(
        consumer,
        "adapters/podman/container.js",
    );
    const runModule = await installedModule<typeof installed>(
        consumer,
        "campaign/run.js",
    );
    const prepareModule = await installedModule<typeof installed>(
        consumer,
        "campaign/prepare.js",
    );
    const freezeModule = await installedModule<typeof installed>(
        consumer,
        "campaign/freeze.js",
    );
    const eventsModule = await installedModule<typeof installed>(
        consumer,
        "adapters/opencode/events.js",
    );
    const containmentModule = await installedModule<typeof installed>(
        consumer,
        "evidence/containment.js",
    );
    const primaryModule = await installedModule<typeof installed>(
        consumer,
        "campaign/primary.js",
    );
    const assessModule = await installedModule<typeof installed>(
        consumer,
        "campaign/assess.js",
    );
    const closeModule = await installedModule<typeof installed>(
        consumer,
        "campaign/close.js",
    );
    const statusModule = await installedModule<typeof installed>(
        consumer,
        "campaign/status.js",
    );
    const reportingModule = await installedModule<typeof installed>(
        consumer,
        "reporting/report.js",
    );
    const judgeModule = await installedModule<typeof installed>(
        consumer,
        "campaign/judge.js",
    );
    installed = {
        buildImage: adapters.buildImage,
        resolveImage: adapters.resolveImage,
        runContainer: runtime.runContainer,
        containerArgv: runtime.containerArgv,
        planTrial: runModule.planTrial,
        loadPreparedManifest: prepareModule.loadPreparedManifest,
        loadFrozen: freezeModule.loadFrozen,
        decodeTrail: eventsModule.decodeTrail,
        readContainedFile: containmentModule.readContainedFile,
        readPrimaryCheck: primaryModule.readPrimaryCheck,
        assessCampaign: assessModule.assessCampaign,
        closeCampaign: closeModule.closeCampaign,
        statusOf: statusModule.statusOf,
        analyseCampaign: reportingModule.analyseCampaign,
        judgeSandboxPlanForSlot: judgeModule.judgeSandboxPlanForSlot,
    };

    receipt.sourceSha = must("git", ["rev-parse", "HEAD"], {
        cwd: REPO,
    }).stdout.trim();
    receipt.workingTree = must("git", ["status", "--porcelain"], {
        cwd: REPO,
    }).stdout.trim();
    receipt.tarballSha256 = tarball.sha256;
    receipt.packageVersion = tarball.version;
    receipt.consumer = consumer;
    receipt.node = process.version;
    receipt.podman = must("podman", ["--version"]).stdout.trim();

    const nodeBase =
        process.env.OTC_SMOKE_NODE_BASE ??
        "docker.io/library/node:26.13.0-slim";
    const reusable = process.env.OTC_SMOKE_IMAGE;
    if (reusable !== undefined && reusable !== "") {
        imageTag = reusable;
        receipt.imageReused = true;
    } else {
        const built = await installed.buildImage({
            tag: imageTag,
            nodeBase,
            opencodeVersion,
        });
        if (built.status !== 0) {
            throw new Error(`image build failed: ${built.stderr.trim()}`);
        }
    }
    const resolved = await installed.resolveImage(imageTag, opencodeVersion);
    if (!resolved.ok)
        throw new Error(`image resolve failed: ${resolved.problem}`);
    imageId = resolved.image.imageId;
    receipt.imageTag = imageTag;
    receipt.imageId = imageId;
    receipt.opencodeVersion = resolved.image.opencodeVersion;
    receipt.nodeBase = nodeBase;
    receipt.containerfileSha256 = fileSha256(
        join(REPO, "container", "Containerfile"),
    );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function s01(): Promise<string> {
    const help = await otcMust(env, binary, ["--help"], work);
    expect(
        /otc — an isolated test sandbox/.test(help.stdout),
        "help output changed",
    );
    const version = await otcMust(env, binary, ["--version"], work);
    expect(
        version.stdout.trim() === receipt.packageVersion,
        "installed version differs",
    );
    expect(
        imageId.startsWith("sha256:"),
        "image did not resolve to an immutable id",
    );
    return `installed ${String(receipt.packageVersion)} in a spaced path; image ${imageId.slice(0, 19)}… (${opencodeVersion})`;
}

let skillsRoot = "";
let docsRoot = "";
let providerUsed = 0;

async function s02(): Promise<string> {
    const live = await provider(
        [
            { kind: "tool", tool: "otc_probe", args: { label: "smoke" } },
            { kind: "text", content: "OTC_SCRIPTED_FINAL" },
        ],
        false,
    );
    const directory = join(work, "s02");
    const campaign = writeCampaign({
        directory,
        image: imageTag,
        opencodeVersion,
        baseUrl: `http://127.0.0.1:${live.port}/v1`,
        timeoutMs: 60_000,
    });
    skillsRoot = join(directory, "root");
    await otcMust(
        env,
        binary,
        ["prepare", "--campaign", campaign, "--root", skillsRoot],
        directory,
    );
    await otcMust(env, binary, ["freeze", "--root", skillsRoot], directory);
    await otcMust(env, binary, ["run", "--root", skillsRoot], directory);
    providerUsed += live.chatCount();

    const trial = join(skillsRoot, "evidence", "trials", "smoke-slot");
    const offered = live.requests
        .filter((request) => request.path.includes("chat/completions"))
        .flatMap((request) => {
            const entries = request.body.tools;
            return Array.isArray(entries)
                ? entries.map(
                      (entry) =>
                          (entry as { function?: { name?: string } }).function
                              ?.name ?? "unknown",
                  )
                : [];
        });
    expect(
        offered.includes("otc_probe"),
        `the plugin tool was not offered to the model (${offered.join(", ")})`,
    );
    const tools = readFileSync(join(trial, "tools.jsonl"), "utf8");
    const calls = installed.decodeTrail(
        readFileSync(join(trial, "events.jsonl"), "utf8"),
    ).calls;
    const probeCall = calls.find((call) => call.tool === "otc_probe");
    expect(probeCall !== undefined, "the scripted tool call was not decoded");
    expect(
        (probeCall?.output ?? "").includes(
            "OTC_PLUGIN_TOOL_OK:OTC_PLUGIN_OPTIONS_OK:smoke",
        ),
        "the plugin did not receive its options or the tool result was lost",
    );
    expect(
        tools.includes("OTC_PLUGIN_TOOL_OK"),
        "tool output is absent from tools.jsonl",
    );
    const requestText = JSON.stringify(live.requests);
    expect(
        requestText.includes("OTC_SMOKE_INSTRUCTION_SENTINEL"),
        "the intended instruction fixture did not reach the provider",
    );
    await live.close();
    return `real plugin tool dispatched with options; ${live.chatCount()} scripted chat request(s)`;
}

async function s03(): Promise<string> {
    const assessed = installed.assessCampaign(skillsRoot, {
        now: () => "2026-11-17T00:00:00.000Z",
    });
    expect(assessed.ok, assessed.problems.join("; "));
    expect(assessed.summary.assessed === 1, "the slot was not assessed");
    expect(
        assessed.summary.pass === 1,
        `the ordinary lifecycle did not pass (${JSON.stringify(assessed.summary)})`,
    );
    const path = join(skillsRoot, "evidence", "assessments", "smoke-slot.json");
    const before = readFileSync(path, "utf8");
    const again = installed.assessCampaign(skillsRoot, {
        now: () => "2026-11-17T00:10:00.000Z",
    });
    expect(again.ok, again.problems.join("; "));
    expect(
        readFileSync(path, "utf8") === before,
        "assessment retry changed bytes",
    );
    const closed = installed.closeCampaign(skillsRoot);
    expect(closed.ok, (closed.problems ?? []).join("; "));
    const status = installed.statusOf(skillsRoot);
    expect(status.state === "closed", `status was ${status.state}`);
    const out = join(skillsRoot, "reports", "final");
    const analysed = installed.analyseCampaign(skillsRoot, out);
    expect(analysed.ok, (analysed.problems ?? []).join("; "));
    expect(existsSync(join(out, "report.json")), "report was not written");
    const post = installed.assessCampaign(skillsRoot);
    expect(post.ok, post.problems.join("; "));
    return `assessed, idempotent retry, closed, status ${status.state}, report written`;
}

async function trialPlan(): Promise<Record<string, unknown>> {
    const prepared = installed.loadPreparedManifest(skillsRoot);
    const frozen = installed.loadFrozen(skillsRoot);
    expect(prepared.ok && frozen.ok, "skills root is not frozen");
    const manifest = prepared.manifest as PreparedManifest;
    const slot = manifest.campaign.schedule.slots[0]!;
    const testCase = manifest.suite.cases[0]!;
    const arm = manifest.subjects[0]!;
    const trialDir = (await import("node:fs")).mkdtempSync(
        join(work, "probe-trial-"),
    );
    const planned = installed.planTrial({
        root: skillsRoot,
        manifest,
        frozen: frozen.record,
        slot,
        testCase,
        arm,
        trialDir,
    });
    expect(planned.ok, (planned.problems ?? []).join("; "));
    const plan = planned.plan as Record<string, unknown>;
    const mounts = plan.mounts as Array<{ target: string; source: string }>;
    const workspace = mounts.find((mount) => mount.target === "/workspace");
    expect(workspace !== undefined, "trial plan has no workspace mount");
    writeFileSync(join(workspace!.source, "probe.mjs"), FS_PROBE, "utf8");
    return plan;
}

async function s04(): Promise<string> {
    const plan = await trialPlan();
    const observed = await probe(
        installed.runContainer,
        plan,
        "/workspace/probe.mjs",
    );
    const writes = observed.writes as Record<string, string>;
    expect(writes.workspace === "ok", "the workspace was not writable");
    expect(writes.tmp === "ok", "the tmp area was not writable");
    expect(writes.subjects === "denied", "subjects were writable");
    expect(writes.config === "denied", "the config home was writable");
    expect(writes.root === "denied", "the image root filesystem was writable");
    expect(
        String(observed.uid) === String(process.getuid?.() ?? "0"),
        "uid mapping differs",
    );
    expect(
        observed.caps === "0000000000000000",
        `capabilities were ${String(observed.caps)}`,
    );
    expect(observed.noNewPrivs === "1", "no-new-privileges was not set");
    return `workspace/tmp writable; subjects/config/root denied; uid ${String(observed.uid)}; caps 0; NNP 1`;
}

async function s05(): Promise<string> {
    const plan = await trialPlan();
    const hostDir = join(work, "host-sentinel");
    mkdirSync(hostDir, { recursive: true });
    const sentinel = "OTC_HOST_SENTINEL_7f3a";
    writeFileSync(join(hostDir, "sentinel.txt"), `${sentinel}\n`, "utf8");
    const mounts = plan.mounts as Array<Record<string, unknown>>;
    const workspace = mounts.find((mount) => mount.target === "/workspace");
    expect(workspace !== undefined, "trial plan has no workspace mount");
    writeFileSync(
        join(String(workspace!.source), "probe.mjs"),
        HOST_PROBE,
        "utf8",
    );
    const observed = await probe(
        installed.runContainer,
        plan,
        "/workspace/probe.mjs",
        {
            mounts: [
                ...mounts,
                {
                    source: hostDir,
                    target: "/control",
                    readOnly: true,
                },
            ],
            envNames: ["HOST_SENTINEL", "PROBE_PORT"],
            envFile: (() => {
                const path = join(work, "probe.env");
                writeFileSync(
                    path,
                    `HOST_SENTINEL=${join(hostDir, "sentinel.txt")}\nPROBE_PORT=1\n`,
                    { mode: 0o600 },
                );
                return path;
            })(),
        },
    );
    expect(
        observed.hostSentinel === "denied",
        "an absolute host path was readable",
    );
    expect(
        observed.mountedSentinel === sentinel,
        "the positive control mount was not readable",
    );
    // The host-side evidence boundary must refuse an escaping workspace link.
    const escape = join(String(workspace!.source), "escape");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(hostDir, escape);
    const read = installed.readContainedFile(
        String(workspace!.source),
        "escape/sentinel.txt",
    );
    expect(!read.ok, "host-side containment accepted an escaping symlink");
    return "host path denied; control mount read; escaping workspace link refused on the host";
}

async function s06(): Promise<string> {
    const listener = await heldPort();
    const live = await provider([{ kind: "text", content: "Done." }], false);
    const directory = join(work, "s06");
    mkdirSync(directory, { recursive: true });
    const docs = join(FIXTURES, "docs");
    const campaign = join(directory, "campaign.json");
    const docsCampaign = JSON.parse(
        readFileSync(join(docs, "campaign.json"), "utf8"),
    ) as {
        runtime: {
            image: string;
            opencodeVersion: string;
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
    docsCampaign.runtime.image = imageTag;
    docsCampaign.runtime.opencodeVersion = opencodeVersion;
    docsCampaign.runtime.provider.overlay.providers[
        "zai-coding-plan"
    ]!.settings.baseURL = `http://127.0.0.1:${live.port}/v1`;
    writeFileSync(
        campaign,
        `${JSON.stringify(docsCampaign, null, 2)}\n`,
        "utf8",
    );
    for (const member of ["suite.json", "workspace", "checker"]) {
        const { cpSync } = await import("node:fs");
        cpSync(join(docs, member), join(directory, member), {
            recursive: true,
        });
    }
    // The checker script carries the host listener port; it has no env channel.
    writeFileSync(
        join(directory, "checker", "probe.mjs"),
        readFileSync(
            join(directory, "checker", "probe.mjs"),
            "utf8",
        ).replaceAll("{{CHECKER_PORT}}", String(listener.port)),
        "utf8",
    );
    const root = join(directory, "root");
    docsRoot = root;
    await otcMust(
        env,
        binary,
        ["prepare", "--campaign", campaign, "--root", root],
        directory,
    );
    await otcMust(env, binary, ["freeze", "--root", root], directory);
    await otcMust(env, binary, ["run", "--root", root], directory);
    providerUsed += live.chatCount();
    const record = installed.readPrimaryCheck(
        join(root, "evidence", "trials", "checker-slot"),
    );
    expect(record !== null, "no primary-check record was written");
    expect(
        record?.status === "pass",
        `checker status was ${String(record?.status)}`,
    );
    const observed = parseProbe<Record<string, unknown>>(
        (record as unknown as { stdout: string }).stdout,
    );
    expect(
        observed.canWriteLive === false,
        "the checker wrote live workspace evidence",
    );
    expect(
        observed.canWritePristine === false,
        "the checker wrote pristine evidence",
    );
    expect(
        observed.canWriteChecker === false,
        "the checker wrote its own payload",
    );
    expect(
        (observed.hasProviderCredentials as string[]).length === 0,
        "the checker received provider credentials",
    );
    expect(
        observed.network !== "connected",
        "the checker reached the host listener",
    );
    expect(
        (await tcpProbe(listener.port)) === "connected",
        "the host listener positive control failed",
    );
    await listener.close();
    await live.close();
    return `checker isolated, no credentials, no network; positive listener control connected`;
}

async function s07(): Promise<string> {
    expect(docsRoot !== "", "S06 did not produce the docs root S07 needs");
    const prepared = installed.loadPreparedManifest(docsRoot);
    expect(prepared.ok, "docs root manifest is unreadable");
    const manifest = prepared.manifest as PreparedManifest;
    const slotId = manifest.campaign.schedule.slots[0]!.slotId;
    const planned = installed.judgeSandboxPlanForSlot(
        docsRoot,
        slotId,
        "attempt-001",
    );
    expect(
        planned.ok,
        `judge plan refused: ${(planned.problems ?? []).join("; ")}`,
    );
    const plan = planned.plan as Record<string, unknown>;
    const mounts = plan.mounts as Array<{ target: string; source: string }>;
    const workMount = mounts.find((mount) => mount.target === "/judge/work");
    expect(workMount !== undefined, "judge plan has no work mount");
    writeFileSync(join(workMount!.source, "probe.mjs"), JUDGE_PROBE, "utf8");
    const observed = await probe(
        installed.runContainer,
        plan,
        "/judge/work/probe.mjs",
    );
    expect(observed.packetReadable === true, "the packet was not readable");
    expect(
        observed.workWritable === true,
        "the judge work area was not writable",
    );
    expect(observed.configWritable === false, "the config home was writable");
    expect(observed.packetWritable === false, "the packet was writable");
    expect(
        observed.subjectsVisible === false,
        "subjects were visible to the judge",
    );
    expect(
        observed.evidenceVisible === false,
        "the evidence root was visible to the judge",
    );
    expect(
        observed.journalKeyPresent === false,
        "a trial-only journal key reached the judge",
    );
    return "packet readable; work writable; config/packet read-only; subjects/evidence absent; journal key absent";
}

async function s08(): Promise<string> {
    const listener = await heldPort();
    const scripts = join(work, "net-scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "probe.mjs"), NET_PROBE, "utf8");
    const envFile = join(work, "net-none.env");
    writeFileSync(envFile, `PROBE_PORT=${listener.port}\n`, { mode: 0o600 });
    const blocked = await probe(
        installed.runContainer,
        {
            imageId,
            mounts: [{ source: scripts, target: "/workspace", readOnly: true }],
            workdir: "/workspace",
            network: "none",
            argv: ["node", "/workspace/probe.mjs"],
            envNames: ["PROBE_PORT"],
            envFile,
            timeoutMs: 20_000,
        },
        "/workspace/probe.mjs",
    );
    expect(
        Object.values(blocked).every((value) => value !== "connected"),
        "network:none reached a host listener",
    );
    expect(
        (await tcpProbe(listener.port)) === "connected",
        "the host listener positive control failed",
    );
    await listener.close();
    return "network:none could not connect; the host listener positive control connected";
}

async function s09(): Promise<string> {
    const observations: string[] = [];
    for (const [label, script] of [
        ["malformed", { kind: "truncate", content: "half an answer" }],
        ["provider-error", { kind: "error", status: 500 }],
    ] as const) {
        const live = await provider([script], false);
        const directory = join(work, `s09-${label}`);
        const campaign = writeCampaign({
            directory,
            image: imageTag,
            opencodeVersion,
            baseUrl: `http://127.0.0.1:${live.port}/v1`,
            timeoutMs: 60_000,
        });
        const root = join(directory, "root");
        await otcMust(
            env,
            binary,
            ["prepare", "--campaign", campaign, "--root", root],
            directory,
        );
        await otcMust(env, binary, ["freeze", "--root", root], directory);
        const executed = await otc(
            env,
            binary,
            ["run", "--root", root],
            directory,
        );
        providerUsed += live.chatCount();
        await live.close();
        const metaPath = join(
            root,
            "evidence",
            "trials",
            "smoke-slot",
            "meta.json",
        );
        if (existsSync(metaPath)) {
            const meta = readJson<{ captureValid: boolean }>(metaPath);
            expect(
                meta.captureValid === false,
                `${label} was accepted as a valid capture`,
            );
        }
        installed.assessCampaign(root);
        const assessment = existsSync(
            join(root, "evidence", "assessments", "smoke-slot.json"),
        )
            ? readJson<{ outcome: string; validity: string }>(
                  join(root, "evidence", "assessments", "smoke-slot.json"),
              )
            : null;
        expect(
            assessment === null || assessment.outcome !== "pass",
            `${label} produced a passing assessment`,
        );
        observations.push(
            `${label}: run ${String(executed.status)}, ${assessment?.validity ?? "unassessed"}`,
        );
    }
    return observations.join("; ");
}

/** One non-blocking TCP probe against a host listener. */
function tcpProbe(
    port: number,
    timeoutMs = 1_200,
    host = "127.0.0.1",
): Promise<"connected" | "refused" | "timeout"> {
    return new Promise((done) => {
        const socket = connect({ host, port });
        const timer = setTimeout(() => {
            socket.destroy();
            done("timeout");
        }, timeoutMs);
        socket.on("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            done("connected");
        });
        socket.on("error", () => {
            clearTimeout(timer);
            done("refused");
        });
    });
}

/** Wait until a predicate holds, bounded. */
async function until(
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((again) => setTimeout(again, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function s10(): Promise<string> {
    const control = `otc-smoke-control-${process.pid}`;
    ownedContainers.push(control);
    must("podman", ["run", "-d", "--name", control, imageId, "sleep", "60"]);
    const scripts = join(work, "long-scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(
        join(scripts, "probe.mjs"),
        "setTimeout(() => {}, 60000)\n",
        "utf8",
    );
    const name = `otc-smoke-timeout-${process.pid}`;
    ownedContainers.push(name);
    const result = (await installed.runContainer({
        imageId,
        mounts: [{ source: scripts, target: "/workspace", readOnly: true }],
        workdir: "/workspace",
        network: "none",
        argv: ["node", "/workspace/probe.mjs"],
        envNames: [],
        envFile: null,
        timeoutMs: 1500,
        name,
        labels: { "otc.owner": "smoke" },
    })) as { timedOut: boolean };
    expect(result.timedOut === true, "the long probe did not time out");
    const gone = run("podman", ["container", "exists", name]);
    expect(gone.status !== 0, "the owned container survived timeout cleanup");
    const survives = run("podman", ["container", "exists", control]);
    expect(survives.status === 0, "cleanup touched an unrelated container");
    must("podman", ["rm", "-f", control]);

    // Cancellation: a live trial waiting on a stalled provider receives SIGINT
    // and must leave no owned container or env file behind.
    const live = await provider([{ kind: "stall" }], false);
    const directory = join(work, "s10-cancel");
    const campaign = writeCampaign({
        directory,
        image: imageTag,
        opencodeVersion,
        baseUrl: `http://127.0.0.1:${live.port}/v1`,
        timeoutMs: 300_000,
    });
    const root = join(directory, "root");
    await otcMust(
        env,
        binary,
        ["prepare", "--campaign", campaign, "--root", root],
        directory,
    );
    await otcMust(env, binary, ["freeze", "--root", root], directory);
    const child = spawn(binary, ["run", "--root", root], {
        cwd: directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((done) => {
        child.on("close", (code) => done(code));
    });
    try {
        await until(
            () =>
                existsSync(
                    join(
                        root,
                        "evidence",
                        "trials",
                        "smoke-slot",
                        "launch.json",
                    ),
                ),
            60_000,
            "the trial launch",
        );
        child.kill("SIGINT");
        const code = await Promise.race([
            exited,
            new Promise<null>((done) => setTimeout(() => done(null), 60_000)),
        ]);
        expect(
            code !== null,
            "the cancelled CLI did not exit within the bound",
        );
        await until(
            () => {
                const left = run("podman", [
                    "ps",
                    "--filter",
                    "label=otc.campaign=otc-smoke",
                    "--format",
                    "{{.Names}}",
                ]);
                return left.stdout.trim() === "";
            },
            30_000,
            "owned container cleanup",
        );
        const trial = join(root, "evidence", "trials", "smoke-slot");
        expect(
            existsSync(join(trial, "trial.env")) === false,
            "the cancelled attempt left its credential env file",
        );
        expect(
            existsSync(join(trial, "meta.json")),
            "the cancelled attempt left no terminal evidence",
        );
    } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await live.close();
    }
    return "timeout removed its owned container; unrelated control survived; SIGINT cleaned up a live trial";
}

async function s11(): Promise<string> {
    const observations: string[] = [];
    for (const canary of ["CANARY_ATTEMPT_ONE", "CANARY_ATTEMPT_TWO"]) {
        const directory = join(work, `s11-${canary}`);
        const live = await provider(
            [{ kind: "text", content: "Done." }],
            false,
        );
        const campaign = writeCampaign({
            directory,
            image: imageTag,
            opencodeVersion,
            baseUrl: `http://127.0.0.1:${live.port}/v1`,
            timeoutMs: 60_000,
        });
        const root = join(directory, "root");
        await otcMust(
            env,
            binary,
            ["prepare", "--campaign", campaign, "--root", root],
            directory,
        );
        await otcMust(env, binary, ["freeze", "--root", root], directory);
        await otcMust(env, binary, ["run", "--root", root], directory);
        providerUsed += live.chatCount();
        await live.close();
        const files = filesUnder(
            join(root, "evidence", "trials", "smoke-slot", "workspace"),
        );
        const text = files.map((path) => readFileSync(path, "utf8")).join("\n");
        const other =
            canary === "CANARY_ATTEMPT_ONE"
                ? "CANARY_ATTEMPT_TWO"
                : "CANARY_ATTEMPT_ONE";
        expect(
            !text.includes(other),
            "a later attempt inherited a previous canary",
        );
        observations.push(`${canary}: no cross-attempt state`);
    }
    return observations.join("; ");
}

async function s12(): Promise<string> {
    const directory = join(work, "s12");
    const live = await provider([{ kind: "text", content: "Done." }], false);
    const campaign = writeCampaign({
        directory,
        image: imageTag,
        opencodeVersion,
        baseUrl: `http://127.0.0.1:${live.port}/v1`,
        timeoutMs: 60_000,
    });
    const root = join(directory, "root");
    await otcMust(
        env,
        binary,
        ["prepare", "--campaign", campaign, "--root", root],
        directory,
    );
    await otcMust(env, binary, ["freeze", "--root", root], directory);
    await otcMust(env, binary, ["run", "--root", root], directory);
    providerUsed += live.chatCount();
    await live.close();
    expect(installed.assessCampaign(root).ok, "assessment failed");
    const path = join(root, "evidence", "assessments", "smoke-slot.json");
    const value = readJson<Record<string, unknown>>(path);
    value.outcome = "fail";
    value.reasons = ["tampered by S12"];
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const status = installed.statusOf(root);
    expect(status.state === "blocked", `tampered status was ${status.state}`);
    const closed = installed.closeCampaign(root);
    expect(!closed.ok, "closure accepted a tampered assessment");
    const unsafe = installed.analyseCampaign(
        root,
        join(root, "evidence", "report"),
    );
    expect(!unsafe.ok, "reporting accepted a protected destination");
    const safe = installed.analyseCampaign(
        root,
        join(root, "reports", "final"),
    );
    expect(!safe.ok, "reporting trusted tampered evidence");
    return "status blocked; closure and reporting refused the tampered record";
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
    await setup();
    await testCase("S01", "packaged build and arbitrary consumer cwd", s01);
    await testCase("S02", "real skill, instruction and plugin wiring", s02);
    await testCase("S03", "complete ordinary lifecycle", s03);
    await testCase("S04", "trial filesystem policy", s04);
    await testCase("S05", "host filesystem isolation", s05);
    await testCase("S06", "primary-checker isolation", s06);
    await testCase("S07", "judge sandbox policy", s07);
    await testCase("S08", "explicit network-none boundary", s08);
    await testCase("S09", "capture and provider failures", s09);
    await testCase("S10", "timeout and cancellation cleanup", s10);
    await testCase("S11", "isolation of successive attempts", s11);
    await testCase("S12", "evidence tampering and safe reporting", s12);
} catch (error) {
    record(
        "setup",
        "shared setup",
        false,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
} finally {
    // Only this suite's own control containers are ever removed.
    for (const name of ownedContainers) {
        run("podman", ["rm", "-f", name]);
    }
    receipt.cases = results;
    receipt.finishedAt = new Date().toISOString();
    receipt.scriptedInferenceRequests = providerUsed;
    receipt.retain = retain;
    const receiptPath = join(work, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(`receipt: ${receiptPath}`);
    if (!retain) remove(work);
    const failed = results.filter((result) => !result.ok);
    console.log(
        `smoke: ${results.length - failed.length}/${results.length} case(s) passed; ${providerUsed} scripted inference request(s); image ${imageId}`,
    );
    const expected = wanted?.length ?? 12;
    process.exit(failed.length === 0 && results.length === expected ? 0 : 1);
}
