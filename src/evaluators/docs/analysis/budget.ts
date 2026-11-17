/**
 * Compatibility re-export.
 *
 * Durable spend ownership is lifecycle infrastructure, not docs semantics. The
 * implementation lives at `src/campaign/budget.ts`; this path remains for the
 * migrated analysis modules and existing consumers.
 */
export * from "../../../campaign/budget.ts";
