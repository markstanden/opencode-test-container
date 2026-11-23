/**
 * Render an unknown value for a human-readable report or problem line.
 *
 * Strings, numbers, booleans, null and undefined keep their `String(...)`
 * form. Objects and arrays are rendered as compact JSON so an unexpected
 * value cannot collapse to `[object Object]` and hide what was recorded.
 * @param value The value to render.
 * @returns A printable, single-line form of the value.
 */
export function displayValue(value: unknown): string {
    if (value === null || typeof value !== "object") return String(value);
    return JSON.stringify(value) ?? String(value);
}
