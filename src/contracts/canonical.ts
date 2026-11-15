import { createHash } from "node:crypto";

/**
 * Stable JSON for identity purposes: object keys are sorted recursively,
 * array order is preserved, and `undefined` members are omitted. Freeze
 * identities and receipts use this serialisation so that formatting cannot
 * change an identity.
 * @param value Any JSON-compatible value.
 * @returns Canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortValue(value));
}

/** Recursively sort object keys, leaving arrays and primitives alone. */
function sortValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value === null || typeof value !== "object") return value;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) sorted[key] = sortValue(entry);
    }
    return sorted;
}

/**
 * The SHA-256 identity of a value's canonical JSON.
 * @param value Any JSON-compatible value.
 * @returns The lower-case hex digest.
 */
export function sha256Of(value: unknown): string {
    return createHash("sha256")
        .update(canonicalJson(value), "utf8")
        .digest("hex");
}

/**
 * The SHA-256 identity of exact bytes.
 * @param bytes The bytes to hash.
 * @returns The lower-case hex digest.
 */
export function sha256Bytes(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}
