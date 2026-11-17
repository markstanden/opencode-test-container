/**
 * Compatibility re-export.
 *
 * The journal verifier had a byte-identical copy in the migrated analysis
 * tree. There is one implementation at `../journal.ts`; this module keeps the
 * analysis import path stable for existing callers and legacy consumers.
 */
export * from "../journal.ts";
