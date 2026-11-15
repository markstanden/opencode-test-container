import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeCell } from "../../src/evaluators/docs/analysis/render.ts";

describe("table escaping variants", () => {
    it("renders absent and object values as single-line cells", () => {
        assert.equal(escapeCell(null), "null");
        assert.equal(escapeCell(undefined), "undefined");
        assert.equal(escapeCell({ a: 1 }), "[object Object]");
        assert.equal(escapeCell("a\r\nb"), "a b");
        assert.equal(escapeCell("  spaced  "), "spaced");
    });
});
