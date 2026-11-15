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
function refuses(overrides: Partial<FreezeInput>, fragment: string): void {
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
        refuses({ started: true }, "refusing to freeze after a launch");
        refuses({ frozen: true }, "refusing to overwrite");
    });

    it("refuses a dirty arm, a short set, duplicate ids or identical delivery", () => {
        refuses(
            { arms: [{ ...arm("A"), clean: false }, arm("B", OTHER)] },
            "dirty",
        );
        refuses({ arms: [arm("A")] }, "at least two arms");
        refuses({ arms: [arm("A"), arm("A")] }, "distinct");
        refuses({ arms: [arm("A"), arm("B")] }, "identical description");
    });

    it("refuses delivery that differs from registration", () => {
        refuses(
            {
                arms: [
                    { ...arm("A"), deliveredHash: sha256Text("drift") },
                    arm("B", OTHER),
                ],
            },
            "delivered description differs",
        );
        refuses(
            {
                arms: [{ ...arm("A"), deliveredChars: 1 }, arm("B", OTHER)],
            },
            "delivered description length differs",
        );
    });

    it("refuses missing image, CLI, measurement, ceilings or rules", () => {
        refuses({ imageId: null }, "no container image identity");
        refuses({ containerCli: null }, "no container CLI identity");
        refuses({ measurementSha256: null }, "no measurement declaration");
        refuses({ ceilings: null }, "ceiling");
        refuses({ stoppingRules: [] }, "stopping");
    });

    it("refuses empty or escaping inventories", () => {
        refuses({ inventories: [{ path: "rubrics", files: [] }] }, "is empty");
        refuses(
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
        refuses({ inventories: [{ path: " ", files: [] }] }, "directory path");
    });

    it("refuses empty inputs, blank identities and degenerate ceilings", () => {
        refuses({ files: [] }, "no immutable inputs");
        refuses(
            { files: [{ path: " ", sha256: sha256Text("a") }] },
            "path and a hash",
        );
        refuses(
            { files: [{ path: "a.json", sha256: " " }] },
            "path and a hash",
        );
        refuses({ imageId: " " }, "no container image identity");
        refuses({ ceilings: { trial: 0, judge: 1 } }, "ceilings");
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
