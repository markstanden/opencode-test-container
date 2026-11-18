import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import { judgeCampaign } from "../../src/campaign/judge.ts";
import { assessCampaign } from "../../src/campaign/assess.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import { readClaims } from "../../src/campaign/budget.ts";
import { readLedger } from "../../src/campaign/ledger.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";
import { docsCallEvent, writeJournal } from "../support/docs-trial.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, "..", "fixtures", "skill-basic");
const DOCS = join(HERE, "..", "fixtures", "docs-campaign");
const IMAGE_ID = `sha256:${"d".repeat(64)}`;
const TOKEN = "OTC_RETRY_TOKEN";

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
        sessionID: "ses_retry",
        messageID: "msg_retry",
        part: { type: "text", text },
    });
}

/** A trial-only scripted container that counts dispatches. */
function trials(calls: string[]) {
    return async (plan: ContainerPlan): Promise<CommandResult> => {
        calls.push(plan.labels?.["otc.slot"] ?? "checker");
        return {
            status: 0,
            signal: null,
            stdout: `${textEvent("No activation.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** A docs container that answers trials, checkers and judge packets. */
function docs(calls: { judge: number; trial: number }) {
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
            calls.judge += 1;
            return {
                status: 0,
                signal: null,
                stdout: `${textEvent(
                    JSON.stringify({
                        documentationOutcome: "none",
                        documentationReason:
                            "The evidence supports this outcome.",
                        evidence: ["docs/notes/otel.md"],
                    }),
                )}\n`,
                stderr: "",
                timedOut: false,
                error: null,
            };
        }
        calls.trial += 1;
        const slot = plan.labels?.["otc.slot"] ?? "";
        if (slot === "useful-write") writeJournal(plan, "ses_retry");
        return {
            status: 0,
            signal: null,
            stdout: `${
                slot === "useful-write" ? `${docsCallEvent("ses_retry")}\n` : ""
            }${textEvent("Nothing to record.")}\n`,
            stderr: "",
            timedOut: false,
            error: null,
        };
    };
}

/** Prepare and freeze one temporary campaign. */
async function frozen(
    fixture: string,
    mutate?: (campaign: Record<string, unknown>) => void,
): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-retry-"));
    cpSync(fixture, dir, { recursive: true });
    const campaignPath = join(dir, "campaign.json");
    if (mutate !== undefined) {
        const campaign = JSON.parse(
            readFileSync(campaignPath, "utf8"),
        ) as Record<string, unknown>;
        mutate(campaign);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
            campaignPath,
            `${JSON.stringify(campaign, null, 2)}\n`,
            "utf8",
        );
    }
    const root = join(dir, "root");
    const prepared = prepareCampaign(campaignPath, root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const result = await freezeCampaign(root, fakeImage as never);
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
    return { dir, root };
}

/** Every file name under a directory, recursively. */
function names(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? [entry.name, ...names(path)]
            : [entry.name];
    });
}

describe("pre-dispatch refusal is retriable", () => {
    after(() => {
        delete process.env[TOKEN];
    });

    it("retries a trial, cleans its provisional files and closes", async () => {
        // Arrange
        const { dir, root } = await frozen(SKILLS);
        const calls: string[] = [];
        process.env[TOKEN] = "bad\nvalue";
        try {
            // Act: an environment value Podman could not carry refuses before
            // any dispatch or receipt.
            const refused = await runCampaign(
                root,
                { slotIds: ["s1"], passthrough: [TOKEN] },
                { runContainer: trials(calls) },
            );

            // Assert
            assert.equal(refused.ok, false);
            assert.deepEqual(refused.ran, []);
            assert.match(refused.problems.join("; "), new RegExp(TOKEN));
            assert.equal(calls.length, 0);
            assert.equal(
                existsSync(join(root, "evidence", "trials", "s1")),
                false,
            );
            assert.deepEqual(readClaims(join(root, "evidence"), "trial"), []);
            assert.equal(
                readLedger(root).events.some(
                    (event) => event.event === "trial-start",
                ),
                false,
            );

            // Act: correction, then the same invocation succeeds once.
            delete process.env[TOKEN];
            const retried = await runCampaign(
                root,
                { slotIds: ["s1"], passthrough: [TOKEN] },
                { runContainer: trials(calls) },
            );
            assert.equal(retried.ok, true, retried.problems.join("; "));
            assert.deepEqual(retried.ran, ["s1"]);
            assert.equal(calls.length, 1);

            // Act: the accepted evidence assesses and closes.
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));
            const closed = closeCampaign(root);
            assert.equal(
                closed.ok,
                true,
                closed.ok ? "" : closed.problems.join("; "),
            );
        } finally {
            delete process.env[TOKEN];
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("retries a judge attempt and closes the campaign", async () => {
        // Arrange
        const { dir, root } = await frozen(DOCS, (campaign) => {
            campaign.runtime = {
                ...(campaign.runtime as Record<string, unknown>),
                passthroughEnv: [TOKEN],
            };
        });
        const calls = { judge: 0, trial: 0 };
        process.env[TOKEN] = "safe-value";
        try {
            const ran = await runCampaign(
                root,
                {},
                { runContainer: docs(calls) },
            );
            assert.equal(ran.ok, true, ran.problems.join("; "));
            const assessed = assessCampaign(root);
            assert.equal(assessed.ok, true, assessed.problems.join("; "));

            // Act: the judge cannot build a safe environment for the attempt.
            process.env[TOKEN] = "line\nbreak";
            const refused = await judgeCampaign(
                root,
                {},
                {
                    runContainer: docs(calls),
                },
            );

            // Assert
            assert.equal(refused.ok, false);
            assert.equal(calls.judge, 0);
            assert.equal(
                existsSync(
                    join(
                        root,
                        "evidence",
                        "judgements",
                        "useful-write",
                        "attempt-001",
                    ),
                ),
                false,
            );
            assert.deepEqual(readClaims(join(root, "evidence"), "judge"), []);
            const judgementNames = names(join(root, "evidence", "judgements"));
            assert.equal(
                judgementNames.some((name) => /^attempt-/.test(name)),
                false,
                judgementNames.join("; "),
            );
            assert.equal(
                judgementNames.some((name) => name === "judge.env"),
                false,
                "a provisional judge environment file survived",
            );
            assert.equal(
                readLedger(root).events.some(
                    (event) => event.event === "judge-attempt",
                ),
                false,
            );

            // Act: correction, retry and closure.
            process.env[TOKEN] = "safe-value";
            const retried = await judgeCampaign(
                root,
                {},
                {
                    runContainer: docs(calls),
                },
            );
            assert.equal(retried.ok, true, retried.problems.join("; "));
            assert.equal(calls.judge, 3);
            const closed = closeCampaign(root);
            assert.equal(
                closed.ok,
                true,
                closed.ok ? "" : closed.problems.join("; "),
            );
        } finally {
            delete process.env[TOKEN];
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
