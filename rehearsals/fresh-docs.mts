/**
 * Fresh docs campaign rehearsal.
 *
 * Real Podman image, real OpenCode CLI and the real docs plugin, with a
 * scripted loopback provider. Exercises the complete lifecycle: primary check,
 * blind judge, one registered json-syntax recovery, durable budget refusal,
 * checked selection, closure, analysis and post-close refusal.
 *
 * Manual command, separate from `npm test`; zero paid provider calls.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rehearsalRoot } from "./root.mts";
import {
    startProvider,
    type CapturedRequest,
    type ScriptedResponse,
} from "./provider.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI = process.env.OTC_CLI ?? join(REPO, "dist", "cli", "otc.js");
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
        const child = spawn(CLI, args, {
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

/** Write the campaign JSON with the resolved image, plugin and provider port. */
function writeCampaign(path: string, imageId: string, port: number): void {
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
    campaign.runtime.imageId = imageId;
    campaign.runtime.provider.overlay.providers["zai-coding-plan"] = {
        settings: { baseURL: `http://127.0.0.1:${port}/v1` },
    };
    for (const subject of campaign.subjects) {
        for (const plugin of subject.plugins ?? []) {
            plugin.path = DOCS_PLUGIN;
        }
    }
    writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
}

/** Read one JSON record, or null. */
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

/** Fail the rehearsal with one readable message. */
function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`rehearsal assertion failed: ${message}`);
}

/** The docs write plan for the useful-write slot. */
const USEFUL: ScriptedResponse[] = [
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
        id: "call_useful",
    },
    { kind: "text", content: "Recorded the convention." },
];

/** The refused-write plan for the gate-blocked slot. */
const BLOCKED: ScriptedResponse[] = [
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
        },
        id: "call_blocked",
    },
    { kind: "text", content: "The write was refused." },
];

/** A plain answer plan. */
const PLAIN: ScriptedResponse[] = [
    {
        kind: "text",
        content: "Renamed the variable; nothing durable to record.",
    },
];

/**
 * A packet marker and padding above the host's ordinary single-argument limit
 * (128 KiB). The judge packet carries the authored truth, so this proves the
 * packet reaches the provider through stdin rather than argv.
 */
const LARGE_PACKET_MARKER = "OTC-LARGE-PACKET-MARKER-20261118";
const LARGE_PACKET_PADDING = 200 * 1024;

/** One judge verdict. */
function verdict(outcome: string): ScriptedResponse {
    return {
        kind: "text",
        content: JSON.stringify({
            documentationOutcome: outcome,
            documentationReason: "The recorded documents support this outcome.",
            evidence: ["The knowledge lake and the final answer."],
        }),
    };
}

/** Run one CLI step against a fresh provider plan and count requests. */
async function withProvider(
    plan: ScriptedResponse[],
    port: number,
    run: () => Promise<ChildResult>,
): Promise<{
    result: ChildResult;
    chatRequests: number;
    otherRequests: number;
    requests: CapturedRequest[];
}> {
    const provider = await startProvider(port, plan);
    try {
        return {
            result: await run(),
            chatRequests: provider.chatCount(),
            otherRequests: provider.otherCount(),
            requests: [...provider.requests],
        };
    } finally {
        await provider.close();
    }
}

/** One observed slot. */
interface SlotObservation {
    slotId: string;
    trialChat: number;
    trialOther: number;
    judgeChat: number;
    judgeOther: number;
    judgeRequests: CapturedRequest[];
    assessment: Record<string, unknown> | null;
    selection: Record<string, unknown> | null;
    attempts: Array<Record<string, unknown>>;
    primary: Record<string, unknown> | null;
}

/** Run one fresh docs campaign root and return observations. */
async function runCampaign(
    work: string,
    imageId: string,
): Promise<{ root: string; observations: SlotObservation[] }> {
    const root = join(work, "campaign");
    cpSync(join(HERE, "fixtures", "fresh-docs"), root, { recursive: true });
    // Pad one authored truth so its blinded packet is above the host's
    // single-argument limit.
    const suitePath = join(root, "suite.json");
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as {
        cases: Array<{ caseId: string; truth?: string }>;
    };
    for (const testCase of suite.cases) {
        if (testCase.caseId === "useful-write") {
            testCase.truth = `${LARGE_PACKET_MARKER}${"x".repeat(LARGE_PACKET_PADDING)}`;
        }
    }
    writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
    const port = await freePort();
    writeCampaign(join(root, "campaign.json"), imageId, port);
    const prepared = await otc([
        "prepare",
        "--campaign",
        join(root, "campaign.json"),
        "--root",
        join(root, "root"),
    ]);
    expect(prepared.status === 0, `prepare failed: ${prepared.stderr}`);
    const frozen = await otc(["freeze", "--root", join(root, "root")]);
    expect(frozen.status === 0, `freeze failed: ${frozen.stderr}`);

    const trialPlans: Record<string, ScriptedResponse[]> = {
        "useful-write": USEFUL,
        "gate-blocked": BLOCKED,
        "primary-failure": PLAIN,
        recovery: PLAIN,
    };
    const observations: SlotObservation[] = [];
    for (const slotId of Object.keys(trialPlans)) {
        const trial = await withProvider(trialPlans[slotId] ?? [], port, () =>
            otc(["run", "--root", join(root, "root"), "--slot", slotId], {
                ZAI_API_KEY: "rehearsal",
            }),
        );
        expect(
            trial.result.status === 0,
            `${slotId} run failed: ${trial.result.stderr}`,
        );
        observations.push({
            slotId,
            trialChat: trial.chatRequests,
            trialOther: trial.otherRequests,
            judgeChat: 0,
            judgeOther: 0,
            judgeRequests: [],
            assessment: null,
            selection: null,
            attempts: [],
            primary: json(
                join(
                    root,
                    "root",
                    "evidence",
                    "trials",
                    slotId,
                    "primary-check.json",
                ),
            ),
        });
    }
    const assessed = await otc(["assess", "--root", join(root, "root")]);
    expect(assessed.status === 0, `assess failed: ${assessed.stderr}`);

    const judgePlans: Record<string, ScriptedResponse[]> = {
        "useful-write": [verdict("useful-create")],
        "gate-blocked": [verdict("none")],
        "primary-failure": [verdict("none")],
        recovery: [{ kind: "text", content: "not json" }, verdict("none")],
    };
    for (const observation of observations) {
        const judged = await withProvider(
            judgePlans[observation.slotId] ?? [],
            port,
            () =>
                otc(
                    [
                        "judge",
                        "--root",
                        join(root, "root"),
                        "--slot",
                        observation.slotId,
                    ],
                    { ZAI_API_KEY: "rehearsal" },
                ),
        );
        observation.judgeChat = judged.chatRequests;
        observation.judgeOther = judged.otherRequests;
        observation.judgeRequests = judged.requests;
        observation.assessment = json(
            join(
                root,
                "root",
                "evidence",
                "assessments",
                `${observation.slotId}.json`,
            ),
        );
        observation.selection = json(
            join(
                root,
                "root",
                "evidence",
                "judgements",
                observation.slotId,
                "selection.json",
            ),
        );
        const judgeDir = join(
            root,
            "root",
            "evidence",
            "judgements",
            observation.slotId,
        );
        observation.attempts = existsSync(judgeDir)
            ? (readdirSyncSafe(judgeDir) as string[]).flatMap((name) => {
                  const meta = json(join(judgeDir, name, "meta.json"));
                  return meta === null ? [] : [meta];
              })
            : [];
        expect(
            judged.result.status === 0,
            `${observation.slotId} judge failed: ${judged.result.stderr}`,
        );
    }
    return { root: join(root, "root"), observations };
}

/** List directory names, or an empty list. */
function readdirSyncSafe(directory: string): string[] {
    try {
        return (readdirSync(directory) as string[]).filter((name) =>
            name.startsWith("attempt-"),
        );
    } catch {
        return [];
    }
}

/** Run the budget-exhaustion root. */
async function runExhausted(
    work: string,
    imageId: string,
): Promise<{
    status: number | null;
    chatRequests: number;
    attempts: number;
    selection: boolean;
}> {
    const root = join(work, "exhausted");
    cpSync(join(HERE, "fixtures", "fresh-docs"), root, { recursive: true });
    const campaignPath = join(root, "campaign.json");
    const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
        schedule: { slots: Array<Record<string, unknown>> };
        budgets: { trials: number; judgeAttempts: number };
        assessment: {
            recovery: { recoveryCeiling: number; totalJudgeAttempts: number };
        };
    };
    campaign.schedule.slots = campaign.schedule.slots.filter(
        (slot) => slot.slotId === "recovery",
    );
    campaign.budgets.trials = 1;
    campaign.budgets.judgeAttempts = 1;
    campaign.assessment.recovery.recoveryCeiling = 1;
    campaign.assessment.recovery.totalJudgeAttempts = 1;
    writeFileSync(
        campaignPath,
        `${JSON.stringify(campaign, null, 2)}\n`,
        "utf8",
    );
    const port = await freePort();
    writeCampaign(campaignPath, imageId, port);
    const prepared = await otc([
        "prepare",
        "--campaign",
        campaignPath,
        "--root",
        join(root, "root"),
    ]);
    expect(
        prepared.status === 0,
        `exhausted prepare failed: ${prepared.stderr}`,
    );
    const frozen = await otc(["freeze", "--root", join(root, "root")]);
    expect(frozen.status === 0, `exhausted freeze failed: ${frozen.stderr}`);
    const run = await withProvider(USEFUL, port, () =>
        otc(["run", "--root", join(root, "root")], {
            ZAI_API_KEY: "rehearsal",
        }),
    );
    expect(
        run.result.status === 0,
        `exhausted run failed: ${run.result.stderr}`,
    );
    // Judging requires the checked deterministic assessment.
    const assessed = await otc(["assess", "--root", join(root, "root")]);
    expect(
        assessed.status === 0,
        `exhausted assess failed: ${assessed.stderr}`,
    );
    const judged = await withProvider(
        [{ kind: "text", content: "not json" }],
        port,
        () =>
            otc(["judge", "--root", join(root, "root")], {
                ZAI_API_KEY: "rehearsal",
            }),
    );
    const judgeDir = join(root, "root", "evidence", "judgements", "recovery");
    const attempts = existsSync(judgeDir) ? readdirSyncSafe(judgeDir) : [];
    return {
        status: judged.result.status,
        chatRequests: judged.chatRequests,
        attempts: attempts.length,
        selection: existsSync(join(judgeDir, "selection.json")),
    };
}

/** Resolve and verify the real image identity and CLI version. */
function imageIdentity(): { imageId: string; version: string } {
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
    return { imageId, version };
}

/** Assert the useful write passed its criterion. */
function assertUseful(byId: Record<string, SlotObservation>): void {
    expect(
        byId["useful-write"]?.assessment?.outcome === "pass",
        "useful write did not pass",
    );
}

/** Assert the gate-blocked write passed with zero credited writes. */
function assertGateBlocked(byId: Record<string, SlotObservation>): void {
    expect(
        byId["gate-blocked"]?.assessment?.outcome === "pass",
        "gate-blocked did not pass",
    );
    const counts = byId["gate-blocked"]?.assessment?.counts as
        Record<string, number> | undefined;
    expect(
        counts?.creditedWrites === 0,
        "refused write earned recording credit",
    );
}

/** Assert the primary failure failed the criterion. */
function assertPrimaryFailure(byId: Record<string, SlotObservation>): void {
    expect(
        byId["primary-failure"]?.assessment?.outcome === "fail",
        "primary failure did not fail the criterion",
    );
    expect(
        byId["primary-failure"]?.primary?.status === "fail",
        "primary-failure checker status is not fail",
    );
}

/** Assert the deterministic criteria and primary outcomes. */
function assertCriteria(byId: Record<string, SlotObservation>): void {
    assertUseful(byId);
    assertGateBlocked(byId);
    assertPrimaryFailure(byId);
}

/** Assert the checked selection and packet equality of the recovery slot. */
function assertRecovery(byId: Record<string, SlotObservation>): void {
    expect(
        byId["recovery"]?.selection?.selectedAttemptId === "attempt-002",
        "recovery did not select attempt-002",
    );
    expect(
        byId["recovery"]?.attempts.length === 2,
        "recovery did not record two attempts",
    );
    const first = byId["recovery"]?.attempts[0];
    const second = byId["recovery"]?.attempts[1];
    expect(
        first?.packetSha256 === second?.packetSha256,
        "recovery packets differ",
    );
    expect(
        byId["recovery"]?.judgeChat === 2,
        "recovery did not make two judge requests",
    );
}

/** Assert every slot's scripted traffic and zero readiness probes. */
function assertTraffic(observations: SlotObservation[]): void {
    for (const observation of observations) {
        expect(
            observation.trialChat > 0,
            `${observation.slotId} made no trial provider request`,
        );
        expect(
            observation.trialOther === 0,
            `${observation.slotId} made a trial readiness probe`,
        );
        expect(
            observation.judgeChat > 0,
            `${observation.slotId} made no judge provider request`,
        );
        expect(
            observation.judgeOther === 0,
            `${observation.slotId} made a judge readiness probe`,
        );
    }
}

/** SHA-256 of one string's exact UTF-8 bytes. */
function textSha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Every user message's text content in one captured request body. */
function userContents(body: unknown): string[] {
    if (typeof body !== "object" || body === null) return [];
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return [];
    return messages.flatMap((message) => {
        if (typeof message !== "object" || message === null) return [];
        const entry = message as { role?: unknown; content?: unknown };
        if (entry.role !== "user") return [];
        if (typeof entry.content === "string") return [entry.content];
        if (!Array.isArray(entry.content)) return [];
        return entry.content.flatMap((part) =>
            typeof part === "object" &&
            part !== null &&
            typeof (part as { text?: unknown }).text === "string"
                ? [(part as { text: string }).text]
                : [],
        );
    });
}

/** Assert every observed slot's primary, criterion, selection and traffic. */
function assertObservations(
    observations: SlotObservation[],
    root: string,
): Record<string, SlotObservation> {
    const byId = Object.fromEntries(
        observations.map((observation) => [observation.slotId, observation]),
    ) as Record<string, SlotObservation>;
    assertCriteria(byId);
    assertRecovery(byId);
    assertTraffic(observations);
    assertPacketTransport(byId, root);
    return byId;
}

/**
 * Assert the blinded packet reached the provider byte for byte. The packet is
 * streamed on stdin, so the exact registered bytes must appear as the user
 * message of a judge request; a marker search alone would pass a truncated or
 * reordered packet.
 */
function assertPacketTransport(
    byId: Record<string, SlotObservation>,
    root: string,
): void {
    const useful = byId["useful-write"];
    expect(useful !== undefined, "no useful-write judge observation");
    const packetPath = join(
        root,
        "evidence",
        "judgements",
        "useful-write",
        "attempt-001",
        "packet.md",
    );
    expect(existsSync(packetPath), `no blinded packet at ${packetPath}`);
    const expected = readFileSync(packetPath, "utf8");
    const expectedSha = textSha256(expected);
    const delivered = useful.judgeRequests
        .filter((request) => request.path.includes("chat/completions"))
        .flatMap((request) => userContents(request.body));
    const matched = delivered.some(
        (content) => textSha256(content) === expectedSha,
    );
    expect(
        matched,
        `the provider's user message did not match the blinded packet exactly (expected ${String(expected.length)} bytes, sha256 ${expectedSha}; received byte lengths ${delivered.map((content) => String(content.length)).join(", ")})`,
    );
    expect(
        expected.length > 128 * 1024,
        "the blinded packet was not above the ordinary single-argument limit",
    );
}

/** Close, analyse and prove post-close refusal. */
async function assertClosure(
    root: string,
    work: string,
): Promise<Record<string, unknown>> {
    const closed = await otc(["close", "--root", root]);
    expect(closed.status === 0, `close failed: ${closed.stderr}`);
    const analysed = await otc([
        "analyse",
        "--root",
        root,
        "--out",
        join(work, "report"),
    ]);
    expect(analysed.status === 0, `analysis failed: ${analysed.stderr}`);
    const report = json(join(work, "report", "report.json"));
    expect(report?.denominators !== undefined, "report has no denominators");
    expect(
        (report?.denominators as Record<string, number>).judged === 4,
        "report did not include every judgement",
    );
    const postRun = await otc(["run", "--root", root]);
    const postJudge = await otc(["judge", "--root", root]);
    expect(postRun.status === 1, "post-close run was not refused");
    expect(postJudge.status === 1, "post-close judge was not refused");
    return report as Record<string, unknown>;
}

/** Assert the exhausted-budget root refused to recover. */
async function assertExhausted(
    work: string,
    imageId: string,
): Promise<Awaited<ReturnType<typeof runExhausted>>> {
    const exhausted = await runExhausted(work, imageId);
    expect(exhausted.status === 1, "exhausted judge was not refused");
    expect(exhausted.attempts === 1, "exhausted judge dispatched a recovery");
    expect(exhausted.selection === false, "exhausted judge wrote a selection");
    expect(
        exhausted.chatRequests === 1,
        "exhausted judge made more than one chat request",
    );
    return exhausted;
}

/** Write and print the rehearsal receipt. */
function publishReport(options: {
    work: string;
    imageId: string;
    version: string;
    observations: SlotObservation[];
    exhausted: Awaited<ReturnType<typeof runExhausted>>;
}): void {
    const report = {
        schemaVersion: 1,
        image: {
            tag: IMAGE,
            id: options.imageId,
            opencodeVersion: options.version.trim(),
        },
        paidProviderCalls: 0,
        scriptedProvider: {
            trialChat: options.observations.reduce(
                (sum, observation) => sum + observation.trialChat,
                0,
            ),
            judgeChat: options.observations.reduce(
                (sum, observation) => sum + observation.judgeChat,
                0,
            ),
            readinessRequests:
                options.observations.reduce(
                    (sum, observation) => sum + observation.trialOther,
                    0,
                ) +
                options.observations.reduce(
                    (sum, observation) => sum + observation.judgeOther,
                    0,
                ),
            exhaustedChat: options.exhausted.chatRequests,
        },
        slots: options.observations.map((observation) => ({
            slotId: observation.slotId,
            primary: observation.primary?.status ?? null,
            outcome: observation.assessment?.outcome ?? null,
            validity: observation.assessment?.validity ?? null,
            selectedAttemptId: observation.selection?.selectedAttemptId ?? null,
            attempts: observation.attempts.length,
            trialChat: observation.trialChat,
            judgeChat: observation.judgeChat,
        })),
        exhausted: options.exhausted,
        work: options.work,
    };
    writeFileSync(
        join(options.work, "fresh-docs-rehearsal.json"),
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8",
    );
    console.log(JSON.stringify(report, null, 2));
}

/** The main rehearsal. */
async function main(): Promise<void> {
    const work = rehearsalRoot(process.argv[2], "otc-fresh-docs-");
    mkdirSync(work, { recursive: true });
    expect(
        existsSync(join(DOCS_PLUGIN, "package.json")),
        `docs plugin missing at ${DOCS_PLUGIN}`,
    );
    const { imageId, version } = imageIdentity();
    const { root, observations } = await runCampaign(work, imageId);
    assertObservations(observations, root);
    await assertClosure(root, work);
    const exhausted = await assertExhausted(work, imageId);
    publishReport({ work, imageId, version, observations, exhausted });
    if (process.env.OTC_KEEP_REHEARSAL !== "1") {
        rmSync(work, { recursive: true, force: true });
    }
}

try {
    await main();
} catch (error: unknown) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
}
