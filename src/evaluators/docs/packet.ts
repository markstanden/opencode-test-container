/**
 * The docs judge packet: construction and arm-blindness.
 *
 * Packet content is docs-evaluator policy, not campaign lifecycle. This module
 * reads prepared prompts, the pristine and live lakes, the primary-check
 * record, verified docs operations and the final answer through the contained
 * evidence readers. The campaign layer supplies only the root, slot identity,
 * case definition and the campaign's own identifiers for the leak check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocsTaskCase, Slot } from "../../contracts/types.ts";
import {
    readContainedDocuments,
    readContainedFile,
} from "../../evidence/containment.ts";
import { trialDirectory } from "../../evidence/paths.ts";
import { changedInventoryPaths, inventory } from "../../campaign/inventory.ts";
import { readPrimaryCheck } from "../../campaign/primary.ts";
import { creditedOperationLines } from "./assess.ts";
import { docChanges, type LakeDocument } from "./campaign.ts";
import { buildAcPrompt, type DocState } from "./scoring.ts";

/** The campaign identifiers a packet must never expose. */
export interface BlindnessIdentity {
    /** The evidence root, whose path must not appear. */
    root: string;
    /** The campaign id. */
    campaignId: string;
    /** Every arm id. */
    armIds: readonly string[];
    /** Every slot id. */
    slotIds: readonly string[];
    /** Every case id. */
    caseIds: readonly string[];
}

/** Read every Markdown document under one contained workspace lake. */
function lakeDocuments(
    workspace: string,
    lakeRoot: string,
): { ok: true; documents: LakeDocument[] } | { ok: false; problem: string } {
    const read = readContainedDocuments(workspace, lakeRoot, (name) =>
        name.endsWith(".md"),
    );
    if (!read.ok) return read;
    const prefix = lakeRoot === "" ? "" : `${lakeRoot}/`;
    return {
        ok: true,
        documents: read.documents.map((document) => ({
            path: document.path.slice(prefix.length),
            contents: document.contents,
        })),
    };
}

/** The changed, created and removed files between the pristine and live trees. */
function changedPaths(
    pristine: string,
    live: string,
): { ok: true; paths: string[] } | { ok: false; problems: string[] } {
    const before = inventory(pristine);
    const after = inventory(live);
    if (!before.ok || !after.ok) {
        return {
            ok: false,
            problems: [
                ...(before.ok ? [] : [`pristine workspace: ${before.problem}`]),
                ...(after.ok ? [] : [`live workspace: ${after.problem}`]),
            ],
        };
    }
    return {
        ok: true,
        paths: changedInventoryPaths(before.entries, after.entries, [
            "answer.md",
        ]),
    };
}

/** The text of one file, or an empty string. */
function textOf(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The primary evidence a judge sees. */
function primaryEvidence(trialDir: string): {
    status: string;
    exit: number | null;
    stdout: string;
    stderr: string;
} {
    const record = readPrimaryCheck(trialDir);
    return {
        status: record?.status ?? "missing",
        exit: record?.exit ?? null,
        stdout: (record?.stdout ?? "").slice(0, 8000),
        stderr: (record?.stderr ?? "").slice(0, 4000),
    };
}

/**
 * The documentation mutation state for one slot.
 * @param root The campaign root.
 * @param slot The scheduled slot.
 * @param testCase The docs case definition.
 * @returns The mutation state, or every unreadable lake.
 */
export function docStateFor(
    root: string,
    slot: Slot,
    testCase: DocsTaskCase,
): { ok: true; state: DocState } | { ok: false; problems: string[] } {
    const lakeRoot = testCase.lakeRoot ?? "docs";
    const beforeDocs = lakeDocuments(
        join(root, "prepare", "workspaces", testCase.caseId),
        lakeRoot,
    );
    const afterDocs = lakeDocuments(
        join(trialDirectory(root, slot.slotId), "workspace"),
        lakeRoot,
    );
    if (!beforeDocs.ok) {
        return {
            ok: false,
            problems: [`pristine lake ${lakeRoot}: ${beforeDocs.problem}`],
        };
    }
    if (!afterDocs.ok) {
        return {
            ok: false,
            problems: [`live lake ${lakeRoot}: ${afterDocs.problem}`],
        };
    }
    const change = docChanges(beforeDocs.documents, afterDocs.documents);
    return {
        ok: true,
        state: {
            documentsChanged: change.documentsChanged,
            createdPaths: change.createdPaths,
            modifiedPaths: change.modifiedPaths,
        },
    };
}

/**
 * Build one slot's blinded packet and the mutation state it must agree with.
 * @param options The campaign root, slot and docs case.
 * @returns The packet and state, or every refusal.
 * @param options.root The campaign root.
 * @param options.slot The scheduled slot.
 * @param options.testCase The docs case definition.
 */
export function buildPacket(options: {
    root: string;
    slot: Slot;
    testCase: DocsTaskCase;
}):
    | { ok: true; packet: string; state: DocState }
    | { ok: false; problems: string[] } {
    const { root, slot, testCase } = options;
    const trialDir = trialDirectory(root, slot.slotId);
    const lakeRoot = testCase.lakeRoot ?? "docs";
    const pristine = join(root, "prepare", "workspaces", testCase.caseId);
    const beforeDocs = lakeDocuments(pristine, lakeRoot);
    const afterDocs = lakeDocuments(join(trialDir, "workspace"), lakeRoot);
    if (!beforeDocs.ok) {
        return {
            ok: false,
            problems: [`pristine lake ${lakeRoot}: ${beforeDocs.problem}`],
        };
    }
    if (!afterDocs.ok) {
        return {
            ok: false,
            problems: [`live lake ${lakeRoot}: ${afterDocs.problem}`],
        };
    }
    const changed = changedPaths(pristine, join(trialDir, "workspace"));
    if (!changed.ok) return changed;
    const state = docStateFor(root, slot, testCase);
    if (!state.ok) return state;
    const answer = readContainedFile(trialDir, "answer.md");
    if (!answer.ok) {
        return { ok: false, problems: [`trial answer: ${answer.problem}`] };
    }
    const operations = creditedOperationLines(trialDir);
    const packet = buildAcPrompt({
        taskPrompt: textOf(
            join(root, "prepare", "prompts", `${testCase.caseId}.txt`),
        ),
        standingPermission: textOf(join(pristine, "AGENTS.md")),
        scenarioTruth: testCase.truth ?? "",
        beforeDocs: beforeDocs.documents,
        afterDocs: afterDocs.documents,
        changedPaths: changed.paths,
        primary: primaryEvidence(trialDir),
        docsOperations: operations.lines,
        answer: answer.text,
    });
    return { ok: true, packet, state: state.state };
}

/** Escape one identifier for a literal RegExp. */
function literal(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Experiment identifiers that must not appear in a judge packet, derived from
 * the declared campaign rather than historical arm letters or fixture words.
 * @param packet The rendered packet.
 * @param identity The campaign identifiers and evidence root.
 * @returns Problems; empty means the packet is arm-blind.
 */
export function blindingProblems(
    packet: string,
    identity: BlindnessIdentity,
): string[] {
    const identifiers = [
        identity.campaignId,
        ...identity.armIds,
        ...identity.slotIds,
        ...identity.caseIds,
    ];
    const problems = identifiers.flatMap((identifier) => {
        if (identifier === "") return [];
        const escaped = literal(identifier);
        // A distinctive identifier (with a digit or hyphen) is a leak wherever
        // it appears as a token. A plain-word identifier is only a leak in a
        // structural position (path segment, quoted value, assignment), so
        // legitimate task prose such as "the candidate must" is preserved.
        const pattern = /[0-9-]/.test(identifier)
            ? new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i")
            : new RegExp(
                  `(?:[/\\\\]${escaped}(?:[/\\\\]|$)|"${escaped}"|${escaped}=)`,
              );
        return pattern.test(packet)
            ? [`the packet names campaign identifier ${identifier}`]
            : [];
    });
    if (packet.includes(identity.root))
        problems.push("the packet names the evidence root");
    return [...new Set(problems)];
}
