import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCampaignBundle } from "../../src/contracts/validate.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { judgeCampaign } from "../../src/campaign/judge.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { statusOf } from "../../src/campaign/status.ts";
import { readClaims } from "../../src/campaign/budget.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "fixtures", "docs-campaign");
const SKILLS = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"2".repeat(64)}`;

/** A fake image resolver. */
const fakeImage = async (
    _command: string,
    args: readonly string[],
): Promise<CommandResult> => ({
    status: 0,
    signal: null,
    stdout: args.includes("inspect") ? `${IMAGE_ID}\n` : "opencode v2.2.6\n",
    stderr: "",
    timedOut: false,
    error: null,
});

/** A completed text event. */
function textEvent(text: string): string {
    return JSON.stringify({
        type: "text",
        sessionID: "ses_elig",
        messageID: "msg_elig",
        part: { type: "text", text },
    });
}

/** The docs add call, as an OpenCode tool event. */
function docsCall(): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: "ses_elig",
        messageID: "msg_elig",
        part: {
            type: "tool",
            id: "call_1",
            tool: "docs",
            state: {
                status: "completed",
                input: { add: { mode: "create" } },
                output: "repo:notes/otel.md — created.",
            },
        },
    });
}

/** The mount source for one container target. */
function mountSource(plan: ContainerPlan, target: string): string {
    const mount = plan.mounts.find((entry) => entry.target === target);
    assert.notEqual(mount, undefined);
    return (mount as { source: string }).source;
}

/** Write a signed journal record whose credited write is notes/otel.md. */
function writeJournal(plan: ContainerPlan): void {
    const journal = mountSource(plan, "/journal");
    const key = readFileSync(
        join(dirname(journal), "journal-key.txt"),
        "utf8",
    ).trim();
    const record = {
        schemaVersion: 1,
        tool: "docs",
        surface: "native",
        status: "completed",
        input: { add: { mode: "create" } },
        result: {
            content: "created",
            metadata: { written: true, lake: "repo", path: "notes/otel.md" },
        },
        sessionID: "ses_elig",
        messageID: "msg_elig",
        callID: "call_1",
    };
    const mac = createHmac("sha256", key)
        .update(JSON.stringify(record), "utf8")
        .digest("hex");
    writeFileSync(
        join(journal, "docs-operations.jsonl"),
        `${JSON.stringify({ ...record, mac })}\n`,
        "utf8",
    );
}

/** A scripted docs container with per-slot trial behaviour. */
function container(options: {
    writesFile: boolean;
    captureFails?: boolean;
    judgeCalls: { count: number };
    judgeResponses?: (slotId: string, attemptId: string) => string;
    onJudge?: () => Promise<void>;
}) {
    return async (plan: ContainerPlan): Promise<CommandResult> => {
        if (plan.argv[0] === "node") {
            return {
                status: 0,
                signal: null,
                stdout: "",
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        if (plan.mounts.some((mount) => mount.target === "/judge/packet.md")) {
            options.judgeCalls.count += 1;
            await options.onJudge?.();
            const slotId = plan.labels?.["otc.slot"] ?? "";
            const attemptId = plan.labels?.["otc.attempt"] ?? "attempt-001";
            const response =
                options.judgeResponses?.(slotId, attemptId) ??
                JSON.stringify({
                    documentationOutcome: "none",
                    documentationReason:
                        "The evidence supports this outcome.",
                    evidence: ["docs/notes/otel.md"],
                });
            return {
                status: 0,
                signal: null,
                stdout: `${textEvent(response)}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        const slot = plan.labels?.["otc.slot"] ?? "";
        if (slot === "useful-write" && options.captureFails === true) {
            return {
                status: 1,
                signal: null,
                stdout: "",
                stderr: "the subject failed\n",
                timedOut: false,
                error: null,
            };
        }
        if (slot === "useful-write") {
            writeJournal(plan);
            if (options.writesFile) {
                const workspace = mountSource(plan, "/workspace");
                mkdirSync(join(workspace, "docs", "notes"), {
                    recursive: true,
                });
                writeFileSync(
                    join(workspace, "docs", "notes", "otel.md"),
                    "# OpenTelemetry note\n\nName spans after the operation.\n",
                    "utf8",
                );
            }
        }
        return {
            status: 0,
            signal: null,
            stdout: `${
                slot === "useful-write" ? `${docsCall()}\n` : ""
            }${textEvent("Nothing to record.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** Prepare and freeze the docs fixture. */
async function frozenDocs(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-elig-"));
    cpSync(DOCS, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.problems.join("; "));
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

describe("judge eligibility", () => {
    it("rejects skill activation with a judge during validate and prepare", () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-elig-skill-"));
        cpSync(SKILLS, dir, { recursive: true });
        try {
            const path = join(dir, "campaign.json");
            const campaign = JSON.parse(readFileSync(path, "utf8")) as {
                assessment: Record<string, unknown>;
            };
            campaign.assessment.judge = { model: "scripted/judge" };
            writeFileSync(path, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");

            // Act
            const loaded = loadCampaignBundle(path);
            const prepared = prepareCampaign(path, join(dir, "root"));

            // Assert
            assert.equal(loaded.ok, false);
            assert.match(
                loaded.ok ? "" : loaded.problems.join("; "),
                /judge is only supported for docs-recording/,
            );
            assert.equal(prepared.ok, false);
            assert.equal(existsSync(join(dir, "root")), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a paid attempt when the deterministic assessment is missing", async () => {
        // Arrange
        const { dir, root } = await frozenDocs();
        const judgeCalls = { count: 0 };
        const runs = container({ writesFile: true, judgeCalls });
        try {
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, true, ran.problems.join("; "));

            // Act
            const judged = await judgeCampaign(root, {}, {
                runContainer: runs,
            });

            // Assert
            assert.equal(judged.ok, false);
            assert.equal(judgeCalls.count, 0);
            assert.match(
                judged.problems.join("; "),
                /no deterministic assessment/,
            );
            assert.deepEqual(readClaims(join(root, "evidence"), "judge"), []);
            assert.equal(
                existsSync(join(root, "evidence", "judgements")),
                false,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a paid attempt when the checked assessment is invalid", async () => {
        // Arrange: the expected file is missing, so the deterministic
        // assessment is a valid adverse result, but the capture is not.
        const { dir, root } = await frozenDocs();
        const judgeCalls = { count: 0 };
        const runs = container({
            writesFile: false,
            captureFails: true,
            judgeCalls,
        });
        try {
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, false);
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));

            // Act
            const judged = await judgeCampaign(root, {}, {
                runContainer: runs,
            });

            // Assert
            assert.equal(judged.ok, false);
            assert.equal(judgeCalls.count, 0);
            assert.match(judged.problems.join("; "), /invalid/);
            assert.deepEqual(readClaims(join(root, "evidence"), "judge"), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("judges and closes a valid adverse assessment", async () => {
        // Arrange
        const { dir, root } = await frozenDocs();
        const judgeCalls = { count: 0 };
        const runs = container({ writesFile: false, judgeCalls });
        try {
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));
            const status = statusOf(root);
            assert.equal(
                status.judgement?.pending,
                3,
                "every valid assessment with no attempt is pending",
            );

            // Act
            const judged = await judgeCampaign(root, {}, {
                runContainer: runs,
            });

            // Assert
            assert.equal(judged.ok, true, judged.problems.join("; "));
            assert.equal(judgeCalls.count, 3);
            const closed = closeCampaign(root);
            assert.equal(
                closed.ok,
                true,
                closed.ok ? "" : closed.problems.join("; "),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** The judgement a slot's documented state supports. */
function validJudgement(slotId: string): string {
    return JSON.stringify({
        documentationOutcome: slotId === "useful-write" ? "useful-create" : "none",
        documentationReason: "The evidence supports this outcome.",
        evidence: ["docs/notes/otel.md"],
    });
}

describe("recovery conflicts and concurrent closure", () => {
    it("does not let an early failure mask a verdict whose selection is missing", async () => {
        // Arrange: one recoverable failure, then a usable verdict.
        const { dir, root } = await frozenDocs();
        const judgeCalls = { count: 0 };
        const runs = container({
            writesFile: true,
            judgeCalls,
            judgeResponses: (slotId, attemptId) =>
                slotId === "useful-write" && attemptId === "attempt-001"
                    ? "this is not json"
                    : validJudgement(slotId),
        });
        try {
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));
            const judged = await judgeCampaign(root, {}, {
                runContainer: runs,
            });
            assert.equal(judged.ok, true, judged.problems.join("; "));
            rmSync(join(root, "evidence", "judgements", "useful-write", "selection.json"));

            // Act: closure sees a usable verdict with no selection.
            const refused = closeCampaign(root);

            // Assert: the conflict is explained and the ledger stays open.
            assert.equal(refused.ok, false);
            assert.match(
                refused.ok ? "" : refused.problems.join("; "),
                /usable judgement but no checked selection/,
            );
            assert.notEqual(readLedgerState(root), "closed");

            // Act: the judge repairs the missing selection and closure succeeds.
            const repaired = await judgeCampaign(root, {
                slotIds: ["useful-write"],
            }, { runContainer: runs });
            assert.equal(repaired.ok, true, repaired.problems.join("; "));
            assert.equal(
                existsSync(
                    join(
                        root,
                        "evidence",
                        "judgements",
                        "useful-write",
                        "selection.json",
                    ),
                ),
                true,
            );
            const closed = closeCampaign(root);
            assert.equal(
                closed.ok,
                true,
                closed.ok ? "" : closed.problems.join("; "),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a close during terminal publication and then closes cleanly", async () => {
        // Arrange
        const { dir, root } = await frozenDocs();
        const judgeCalls = { count: 0 };
        let releaseJudge: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseJudge = resolve;
        });
        let announceStarted: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            announceStarted = resolve;
        });
        const runs = container({
            writesFile: true,
            judgeCalls,
            judgeResponses: validJudgement,
            onJudge: async () => {
                announceStarted();
                await gate;
            },
        });
        try {
            const ran = await runCampaign(root, {}, { runContainer: runs });
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));

            // Act: a close lands while a judge dispatch is in flight.
            const judging = judgeCampaign(root, {}, { runContainer: runs });
            await started;
            const early = closeCampaign(root);

            // Assert: the in-flight claim keeps the ledger open.
            assert.equal(early.ok, false);
            assert.match(
                early.ok ? "" : early.problems.join("; "),
                /unsettled spend|unresolved|unchecked|judgement/,
            );
            assert.notEqual(readLedgerState(root), "closed");

            // Act: the terminal publication completes, then closure runs.
            releaseJudge();
            const judged = await judging;
            assert.equal(judged.ok, true, judged.problems.join("; "));
            const closed = closeCampaign(root);

            // Assert: claims, verdicts, ledger entries and selections agree.
            assert.equal(
                closed.ok,
                true,
                closed.ok ? "" : closed.problems.join("; "),
            );
            assert.equal(readLedgerState(root), "closed");
            assert.equal(
                readClaims(join(root, "evidence"), "judge").every(
                    (claim) => claim.state === "closed",
                ),
                true,
            );
            assert.equal(
                existsSync(
                    join(
                        root,
                        "evidence",
                        "judgements",
                        "useful-write",
                        "selection.json",
                    ),
                ),
                true,
            );
        } finally {
            releaseJudge();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** The ledger's state, read without trusting its contents. */
function readLedgerState(root: string): string {
    return readFileSync(join(root, "evidence", "ATTEMPTS.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { event?: string })
        .some((event) => event.event === "close")
        ? "closed"
        : "open";
}
