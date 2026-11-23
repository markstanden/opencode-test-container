import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { displayValue } from "../../src/contracts/display.ts";

describe("displayValue", () => {
    const primitives = [
        { name: "a string", value: "text", expected: "text" },
        { name: "a number", value: 42, expected: "42" },
        { name: "a zero", value: 0, expected: "0" },
        { name: "a boolean", value: false, expected: "false" },
        { name: "null", value: null, expected: "null" },
        { name: "undefined", value: undefined, expected: "undefined" },
    ];

    for (const row of primitives) {
        it(`renders ${row.name} like String()`, () => {
            // Arrange / Act
            const rendered = displayValue(row.value);

            // Assert
            assert.equal(rendered, row.expected);
        });
    }

    it("renders an object as compact JSON instead of [object Object]", () => {
        // Arrange / Act
        const rendered = displayValue({ state: "lost", quote: "line" });

        // Assert
        assert.equal(rendered, '{"state":"lost","quote":"line"}');
    });

    it("renders an array as compact JSON", () => {
        // Arrange / Act
        const rendered = displayValue([1, "two"]);

        // Assert
        assert.equal(rendered, '[1,"two"]');
    });
});
