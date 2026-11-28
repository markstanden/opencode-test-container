import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    freezeExperiment,
    sha256Text,
    type FreezeInput,
    type FrozenArm,
} from "../../src/evaluators/docs/analysis/freeze.ts";

const DESCRIPTION = "Record durable findings with the docs tool.";
const OTHER = `${DESCRIPTION} Prefer a durable note.`;

/** One clean arm. */
function arm(id: string, description = DESCRIPTION): FrozenArm {
    return {
        id,
        commit: `commit-${id}`,
        tree: `tree-${id}`,
        clean: true,
        descriptionChars: [...description].length,
        descriptionHash: sha256Text(description),
        deliveredChars: [...description].length,
        deliveredHash: sha256Text(description),
        annotationChars: 1,
        annotationHash: sha256Text("a"),
    };
}

/** A complete freeze input. */
function input(overrides: Partial<FreezeInput> = {}): FreezeInput {
    return {
        campaign: "pd-test",
        sourceRevision: "abc",
        sourceTree: "tree",
        imageId: "sha256:image",
        containerCli: "opencode 2.2.7",
        measurementSha256: sha256Text("m"),
        arms: [arm("A"), arm("B", OTHER)],
        files: [{ path: "a.json", sha256: sha256Text("a") }],
        inventories: [
            {
                path: "rubrics",
                files: [{ path: "rubrics/r.md", sha256: sha256Text("r") }],
            },
        ],
        stoppingRules: ["stop"],
        ceilings: { trial: 2, judge: 2 },
        started: false,
        frozen: false,
        ...overrides,
    };
}

/** Assert a refusal containing the fragment. */
function assertRefuses(
    overrides: Partial<FreezeInput>,
    fragment: string,
): void {
    const outcome = freezeExperiment(input(overrides));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(
        outcome.problems.some((problem) => problem.includes(fragment)),
        outcome.problems.join("; "),
    );
}

describe("freeze refusal branches", () => {
    it("refuses a started or already-frozen experiment", () => {
        assertRefuses({ started: true }, "refusing to freeze after a launch");
        assertRefuses({ frozen: true }, "refusing to overwrite");
    });

    it("refuses a dirty arm, a short set, duplicate ids or identical delivery", () => {
        assertRefuses(
            { arms: [{ ...arm("A"), clean: false }, arm("B", OTHER)] },
            "dirty",
        );
        assertRefuses({ arms: [arm("A")] }, "at least two arms");
        assertRefuses({ arms: [arm("A"), arm("A")] }, "distinct");
        assertRefuses({ arms: [arm("A"), arm("B")] }, "identical description");
    });

    it("refuses delivery that differs from registration", () => {
        assertRefuses(
            {
                arms: [
                    { ...arm("A"), deliveredHash: sha256Text("drift") },
                    arm("B", OTHER),
                ],
            },
            "delivered description differs",
        );
        assertRefuses(
            {
                arms: [{ ...arm("A"), deliveredChars: 1 }, arm("B", OTHER)],
            },
            "delivered description length differs",
        );
    });

    it("refuses missing image, CLI, measurement, ceilings or rules", () => {
        assertRefuses({ imageId: null }, "no container image identity");
        assertRefuses({ containerCli: null }, "no container CLI identity");
        assertRefuses(
            { measurementSha256: null },
            "no measurement declaration",
        );
        assertRefuses({ ceilings: null }, "ceiling");
        assertRefuses({ stoppingRules: [] }, "stopping");
    });

    it("refuses empty or escaping inventories", () => {
        assertRefuses(
            { inventories: [{ path: "rubrics", files: [] }] },
            "is empty",
        );
        assertRefuses(
            {
                inventories: [
                    {
                        path: "rubrics",
                        files: [
                            {
                                path: "elsewhere/r.md",
                                sha256: sha256Text("r"),
                            },
                        ],
                    },
                ],
            },
            "outside rubrics",
        );
        assertRefuses(
            { inventories: [{ path: " ", files: [] }] },
            "directory path",
        );
    });

    it("refuses empty inputs, blank identities and degenerate ceilings", () => {
        assertRefuses({ files: [] }, "no immutable inputs");
        assertRefuses(
            { files: [{ path: " ", sha256: sha256Text("a") }] },
            "path and a hash",
        );
        assertRefuses(
            { files: [{ path: "a.json", sha256: " " }] },
            "path and a hash",
        );
        assertRefuses({ imageId: " " }, "no container image identity");
        assertRefuses({ ceilings: { trial: 0, judge: 1 } }, "ceilings");
    });

    it("deduplicates repeated file paths by path", () => {
        const outcome = freezeExperiment(
            input({
                files: [
                    { path: "a.json", sha256: sha256Text("first") },
                    { path: "a.json", sha256: sha256Text("second") },
                ],
            }),
        );
        assert.equal(outcome.ok, true);
        if (!outcome.ok) return;
        assert.equal(outcome.record.files.length, 1);
        assert.equal(outcome.record.files[0]?.sha256, sha256Text("second"));
    });
});
