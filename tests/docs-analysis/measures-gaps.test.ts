import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    operationMatchesChangedDocument,
    operationMatchesNoteLake,
    operationMatchesNotePath,
    type DocsOperation,
} from "../../src/evaluators/docs/analysis/measures.ts";

/** One docs operation with explicit identity fields. */
function operation(overrides: Partial<DocsOperation> = {}): DocsOperation {
    return {
        verb: "read",
        status: "completed",
        success: null,
        surface: "native",
        line: "",
        path: null,
        target: null,
        lake: "docs",
        ...overrides,
    };
}

const declaration = { note: "ops/deploy.md", lake: "docs", facts: [] };

describe("retrieval identity matching", () => {
    it("accepts the reported path, the qualified path and the bare target", () => {
        assert.equal(
            operationMatchesNotePath(
                operation({ path: "lakes/docs/ops/deploy.md" }),
                declaration,
            ),
            true,
        );
        assert.equal(
            operationMatchesNotePath(
                operation({ target: "docs/ops/deploy.md" }),
                declaration,
            ),
            true,
        );
        assert.equal(
            operationMatchesNotePath(
                operation({ target: "ops/deploy.md" }),
                declaration,
            ),
            true,
        );
    });

    it("refuses a suffix, a contradiction and a missing identity", () => {
        assert.equal(
            operationMatchesNotePath(operation({ path: "shared/db/pool.md" }), {
                note: "db/pool.md",
                lake: "docs",
                facts: [],
            }),
            false,
        );
        assert.equal(
            operationMatchesNotePath(
                operation({
                    path: "lakes/docs/ops/deploy.md",
                    target: "ops/other.md",
                }),
                declaration,
            ),
            false,
        );
        assert.equal(operationMatchesNotePath(operation(), declaration), false);
    });

    it("matches a lake only exactly", () => {
        assert.equal(operationMatchesNoteLake(operation(), declaration), true);
        assert.equal(
            operationMatchesNoteLake(
                operation({ lake: "shared" }),
                declaration,
            ),
            false,
        );
    });
});

describe("changed-document matching", () => {
    it("requires an identity and the same resolved lake", () => {
        assert.equal(
            operationMatchesChangedDocument(
                operation({ path: "lakes/docs/ops/deploy.md" }),
                { path: "ops/deploy.md", lake: "docs", kind: "modified" },
            ),
            true,
        );
        assert.equal(
            operationMatchesChangedDocument(operation(), {
                path: "ops/deploy.md",
                lake: "docs",
                kind: "modified",
            }),
            false,
        );
        assert.equal(
            operationMatchesChangedDocument(
                operation({ path: "lakes/docs/ops/deploy.md", lake: null }),
                { path: "ops/deploy.md", lake: "docs", kind: "modified" },
            ),
            false,
        );
        assert.equal(
            operationMatchesChangedDocument(
                operation({ path: "lakes/other/ops/deploy.md" }),
                { path: "ops/deploy.md", lake: "docs", kind: "modified" },
            ),
            false,
        );
    });
});
