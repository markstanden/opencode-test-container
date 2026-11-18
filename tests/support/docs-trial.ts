/**
 * Scripted docs-trial helpers shared by lifecycle tests.
 *
 * A docs assessment is only valid when the trial's signed operation journal
 * agrees with the host tool trail, so tests that need a judgeable slot script
 * both the tool event and the HMAC-signed journal record.
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

/** The mount source for one container target. */
export function mountSource(plan: ContainerPlan, target: string): string {
    const mount = plan.mounts.find((entry) => entry.target === target);
    if (mount === undefined) {
        throw new Error(`no mount for ${target}`);
    }
    return mount.source;
}

/** One completed text event. */
export function textEvent(text: string, session = "ses_test"): string {
    return JSON.stringify({
        type: "text",
        sessionID: session,
        messageID: "msg_test",
        part: { type: "text", text },
    });
}

/** The docs add call, as an OpenCode tool event. */
export function docsCallEvent(session = "ses_test"): string {
    return JSON.stringify({
        type: "tool_use",
        sessionID: session,
        messageID: "msg_test",
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

/**
 * Write a signed journal record crediting `notes/otel.md` in the docs lake.
 * @param plan The trial plan, whose journal mount and key identify the trial.
 * @param session The session id the journal must attribute.
 */
export function writeJournal(plan: ContainerPlan, session = "ses_test"): void {
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
        sessionID: session,
        messageID: "msg_test",
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

/** The judgement a slot's documented state supports. */
export function validJudgement(slotId: string, outcome?: string): string {
    return JSON.stringify({
        documentationOutcome:
            outcome ?? (slotId.includes("useful") ? "useful-create" : "none"),
        documentationReason: "The evidence supports this outcome.",
        evidence: ["docs/notes/otel.md"],
    });
}
