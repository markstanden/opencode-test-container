import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../../src/evaluators/docs/analysis/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(
    readFileSync(
        join(HERE, "..", "fixtures", "docs-analysis", "manifests", "mini.json"),
        "utf8",
    ),
) as Record<string, unknown>;

/** A deep copy of the base manifest, optionally mutated. */
function manifest(mutate: (value: Record<string, unknown>) => void): unknown {
    const copy = JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>;
    mutate(copy);
    return copy;
}

/** Assert one refusal fragment. */
function assertRefuses(
    mutate: (value: Record<string, unknown>) => void,
    fragment: string,
): void {
    const parsed = parseManifest(manifest(mutate));
    assert.equal(parsed.value, undefined);
    assert.ok(
        parsed.problems.some((problem) => problem.includes(fragment)),
        parsed.problems.join("; "),
    );
}

describe("manifest optional-field branches", () => {
    it("refuses a blank campaign question or arm label", () => {
        assertRefuses((value) => {
            (value.campaign as Record<string, unknown>).question = "";
        }, "campaign.question");
        assertRefuses((value) => {
            (value.arms as Array<Record<string, unknown>>)[0]!.label = "";
        }, "label must be a nonblank string");
    });

    it("refuses malformed arm containers and identities", () => {
        assertRefuses((value) => {
            value.arms = "none";
        }, "arms must be a nonempty array");
        assertRefuses((value) => {
            (value.arms as unknown[])[0] = "arm";
        }, "arms[0] must be an object");
        assertRefuses((value) => {
            (value.arms as Array<Record<string, unknown>>)[0]!.id = "";
        }, "arms[0].id");
    });

    it("refuses malformed evidence layouts and inputs", () => {
        assertRefuses((value) => {
            (value.evidence as Record<string, unknown>).layout = "unknown";
        }, "evidence.layout");
        assertRefuses((value) => {
            (value.evidence as Record<string, unknown>).inputs = { bad: 1 };
        }, "evidence.inputs.bad");
        assertRefuses((value) => {
            (value.evidence as Record<string, unknown>).inputs = [];
        }, "evidence.inputs must be an object");
    });

    it("refuses an undeclared result root and a traversal input", () => {
        assertRefuses((value) => {
            const roots = (value.evidence as Record<string, unknown>)
                .resultRoots as Record<string, unknown>;
            roots.C = "c/results";
        }, "not a declared arm");
        assertRefuses((value) => {
            (value.evidence as Record<string, unknown>).inputs = {
                attempts: "../escape.json",
            };
        }, "evidence.inputs.attempts");
    });

    it("refuses malformed assessment, guardrails and selection", () => {
        assertRefuses((value) => {
            (value.assessment as Record<string, unknown>).selectionPolicy =
                "unknown";
        }, "selectionPolicy");
        assertRefuses((value) => {
            (value.policy as Record<string, unknown>).guardrails = [
                { id: "g", kind: "unknown", requirement: "r" },
            ];
        }, "guardrails[0].kind");
        assertRefuses((value) => {
            const selection = (value.policy as Record<string, unknown>)
                .selection as Record<string, unknown>;
            selection.controlArm = "Z";
        }, "controlArm");
    });

    it("refuses an empty sensitivity grid and blank guardrail requirement", () => {
        assertRefuses((value) => {
            (value.policy as Record<string, unknown>).sensitivity = {
                usefulWeights: [],
                transientPenalties: [1],
            };
        }, "sensitivity");
        assertRefuses((value) => {
            (value.policy as Record<string, unknown>).guardrails = [
                { id: "g", kind: "mutation-policy", requirement: "" },
            ];
        }, "requirement");
    });
});
