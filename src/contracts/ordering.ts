/**
 * Compare two strings by UTF-16 code unit.
 *
 * This is the order `Array#sort` uses by default, made explicit so that
 * sorting stays deterministic and independent of the host locale. Identity
 * hashes and canonical JSON depend on it, so do not substitute
 * `localeCompare` here.
 * @param left The left-hand string.
 * @param right The right-hand string.
 * @returns A negative number, zero, or a positive number.
 */
export function compareCodeUnits(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}
