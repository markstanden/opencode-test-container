#!/usr/bin/env node
/**
 * The `otc` command line: thin handlers over the lifecycle modules. Every
 * command validates at its boundary, prints actionable problems, and exits
 * 0 (ok), 1 (operational failure) or 2 (usage/validation refusal).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareCampaign, prepareSummary } from "../campaign/prepare.ts";
import { deliveryCheck, freezeCampaign } from "../campaign/freeze.ts";
import { runCampaign } from "../campaign/run.ts";
import { judgeCampaign } from "../campaign/judge.ts";
import { assessCampaign } from "../campaign/assess.ts";
import { closeCampaign } from "../campaign/close.ts";
import { statusOf } from "../campaign/status.ts";
import { analyseCampaign } from "../reporting/report.ts";
import { runAnalysis } from "../evaluators/docs/analysis/replay.ts";
import { loadCampaignBundle } from "../contracts/validate.ts";
import { packageVersion } from "../contracts/version.ts";

/** The commands `otc` exposes. */
export const COMMANDS = [
    "validate",
    "prepare",
    "delivery-check",
    "freeze",
    "run",
    "judge",
    "assess",
    "close",
    "analyse",
    "status",
    "replay",
    "help",
    "version",
] as const;

/** One command name. */
export type Command = (typeof COMMANDS)[number];

/** Parsed command-line options. */
export interface CliOptions {
    /** The command value. */
    command: Command;
    /** The campaign value. */
    campaign: string | null;
    /** The root value. */
    root: string | null;
    /** The out value. */
    out: string | null;
    /** The slots value. */
    slots: string[];
    /** The json value. */
    json: boolean;
    /** The dry run value. */
    dryRun: boolean;
    /** The passthrough value. */
    passthrough: string[];
    /** The recorded docs campaign manifest (replay). */
    manifest: string | null;
    /** The recorded evidence root (replay). */
    evidenceRoot: string | null;
    /** Whether to replace an existing analysis output. */
    rerender: boolean;
    /** Whether unbound legacy answers are accepted. */
    allowLegacyUnbound: boolean;
    /** The help value. */
    help: boolean;
}

/** Usage text, kept identical to the documented command list. */
export const USAGE = `otc — an isolated test sandbox for OpenCode plugins, skills and agent instructions

Usage: otc <command> [options]

Commands:
  validate        Validate a campaign and its suite; no writes
  prepare         Validate, then stage an immutable campaign root
  delivery-check  Recheck staged payloads and the freeze receipt
  freeze          Resolve the image ID and freeze all input identities
  run             Execute scheduled slots through Podman and OpenCode
  judge           Blindly judge completed docs trials from checked evidence
  assess          Deterministically assess captured evidence
  close           Append closure to the ledger (idempotent)
  analyse         Render final analysis after closure
  status          Read-only state and next actions
  replay          Replay recorded docs evidence through the docs evaluator
  help            This text
  version         Print the package version

Options:
  --campaign <file>   Campaign JSON (default: $OTC_CAMPAIGN)
  --root <dir>        Campaign root (default: $OTC_ROOT)
  --out <dir>         Fresh report directory (analyse)
  --slot <id>         Select a slot; repeat or comma-separate
  --passthrough <name> Pass one named environment variable into the trial
  --manifest <file>   Recorded docs campaign manifest (replay)
  --evidence-root <dir> Recorded evidence root (replay)
  --rerender          Replace an existing analysis output (replay)
  --allow-legacy-unbound Allow unbound legacy answers (replay)
  --dry-run           Plan a trial without dispatching it
  --json              Machine-readable output (status, validate, assess)
  --help              This text

Examples:
  otc validate --campaign examples/skills/otel-skill-container.json
  otc prepare --campaign campaign.json --root /tmp/otc-run
  otc freeze --root /tmp/otc-run
  otc run --root /tmp/otc-run --dry-run
  otc run --root /tmp/otc-run
  otc judge --root /tmp/otc-run
  otc assess --root /tmp/otc-run
  otc close --root /tmp/otc-run
  otc analyse --root /tmp/otc-run --out /tmp/otc-report
  otc status --root /tmp/otc-run --json
  otc replay --manifest campaign.json --evidence-root evidence --out report
`;

/** Parse argv into a command and its options. */
/** Take one option's value, refusing a missing or flag-like value. */
function optionValue(name: string, args: string[]): string {
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${name} needs a value`);
    }
    return next;
}

/** Apply one value-bearing option; false when the argument is unknown. */
function applyOption(
    options: CliOptions,
    arg: string,
    args: string[],
): boolean {
    switch (arg) {
        case "--campaign":
            options.campaign = optionValue(arg, args);
            return true;
        case "--root":
            options.root = optionValue(arg, args);
            return true;
        case "--out":
            options.out = optionValue(arg, args);
            return true;
        case "--slot":
            options.slots.push(
                ...optionValue(arg, args)
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => entry !== ""),
            );
            return true;
        case "--passthrough":
            options.passthrough.push(optionValue(arg, args));
            return true;
        case "--manifest":
            options.manifest = optionValue(arg, args);
            return true;
        case "--evidence-root":
            options.evidenceRoot = optionValue(arg, args);
            return true;
        default:
            return false;
    }
}

/** Resolve the command name, refusing an unknown one. */
function commandOf(first: string): Command {
    if (!(COMMANDS as readonly string[]).includes(first)) {
        throw new UsageError(`unknown command ${first}`);
    }
    return first as Command;
}

/** Apply every remaining argument to the options. */
function parseOptionLoop(options: CliOptions, args: string[]): void {
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === undefined) break;
        if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--json") options.json = true;
        else if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--rerender") options.rerender = true;
        else if (arg === "--allow-legacy-unbound") {
            options.allowLegacyUnbound = true;
        } else if (!applyOption(options, arg, args)) {
            throw new UsageError(`unknown option ${arg}`);
        }
    }
}

/**
 * Parse argv into a command and its options.
 * @param argv Arguments after the executable.
 * @returns The parsed options.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
    const options: CliOptions = {
        command: "help",
        campaign: process.env.OTC_CAMPAIGN ?? null,
        root: process.env.OTC_ROOT ?? null,
        out: null,
        slots: [],
        json: false,
        dryRun: false,
        passthrough: [],
        manifest: null,
        evidenceRoot: null,
        rerender: false,
        allowLegacyUnbound: false,
        help: false,
    };
    const args = [...argv];
    const first = args.shift();
    if (first === undefined || first === "--help" || first === "-h") {
        return options;
    }
    if (first === "--version" || first === "-v") {
        options.command = "version";
        return options;
    }
    options.command = commandOf(first);
    parseOptionLoop(options, args);
    return options;
}

/** A command-line usage refusal. */
export class UsageError extends Error {}

/** Require a campaign path for commands that read one. */
function requireCampaign(options: CliOptions): string {
    if (options.campaign === null) {
        throw new UsageError("--campaign (or $OTC_CAMPAIGN) is required");
    }
    return options.campaign;
}

/** Require a root for commands that operate on staged state. */
function requireRoot(options: CliOptions): string {
    if (options.root === null) {
        throw new UsageError("--root (or $OTC_ROOT) is required");
    }
    return options.root;
}

/** Print a failure block and return the exit code. */
function fail(problems: string[], code = 2): number {
    for (const problem of problems) console.error(`otc: ${problem}`);
    return code;
}

/** Print a parser refusal and return the usage exit code. */
function usageFailure(error: unknown): number | null {
    if (!(error instanceof UsageError)) return null;
    console.error(`otc: ${error.message}`);
    console.error(USAGE);
    return 2;
}

/** Map a handler exception to a documented exit code and concise message. */
function handlerFailure(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);
    // An unknown selector is invalid input, not an operational failure; it is
    // rejected before any dispatch, so no evidence has been written.
    const usage =
        error instanceof Error && message.startsWith("unknown slotId");
    console.error(`otc: ${message}`);
    return usage ? 2 : 1;
}

/** Dispatch one parsed command through its handler. */
async function dispatch(options: CliOptions): Promise<number> {
    const handler = HANDLERS[options.command];
    if (handler === undefined) return 0;
    try {
        return await handler(options);
    } catch (error) {
        return handlerFailure(error);
    }
}

/**
 * Run one command and return its exit code.
 * @param argv Arguments after the executable.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
    let options: CliOptions;
    try {
        options = parseArgs(argv);
    } catch (error) {
        const usage = usageFailure(error);
        if (usage !== null) return usage;
        throw error;
    }
    if (options.help || options.command === "help") {
        console.log(USAGE);
        return 0;
    }
    if (options.command === "version") {
        console.log(packageVersion());
        return 0;
    }
    if (options.command === "analyse" && options.out === null) {
        return fail(["analyse needs --out <fresh-directory>"]);
    }
    return dispatch(options);
}

/** Validate a campaign bundle and print its summary. */
function validate(options: CliOptions): number {
    const loaded = loadCampaignBundle(requireCampaign(options));
    if (!loaded.ok) return fail(loaded.problems);
    const bundle = loaded.value;
    const summary = {
        campaignId: bundle.campaign.campaignId,
        suiteId: bundle.suite.suiteId,
        assessment: bundle.suite.assessment,
        cases: bundle.suite.cases.length,
        arms: bundle.campaign.subjects.length,
        slots: bundle.campaign.schedule.slots.length,
    };
    console.log(
        options.json
            ? JSON.stringify({ ok: true, ...summary }, null, 2)
            : `valid: ${summary.campaignId} / ${summary.suiteId}; ${summary.cases} case(s), ${summary.arms} arm(s), ${summary.slots} slot(s)`,
    );
    return 0;
}

/** Stage a fresh campaign root. */
function prepare(options: CliOptions): number {
    const prepared = prepareCampaign(
        requireCampaign(options),
        requireRoot(options),
    );
    if (!prepared.ok) return fail(prepared.problems);
    console.log(prepareSummary(prepared.manifest));
    return 0;
}

/** Recheck staged payloads and the freeze receipt. */
function checkDelivery(options: CliOptions): number {
    const root = requireRoot(options);
    const problems = deliveryCheck(root);
    if (problems.length > 0) return fail(problems, 1);
    console.log(`delivery intact: ${root}`);
    return 0;
}

/** Resolve and freeze the runtime identity. */
async function freeze(options: CliOptions): Promise<number> {
    const frozen = await freezeCampaign(requireRoot(options));
    if (!frozen.ok) return fail(frozen.problems, 1);
    console.log(
        frozen.alreadyFrozen
            ? `already frozen: ${frozen.record.imageId}`
            : `frozen: ${frozen.record.imageId} (${frozen.record.opencodeVersion})`,
    );
    return 0;
}

/** Execute the selected slots. */
async function run(options: CliOptions): Promise<number> {
    // Ctrl-C cancels the owned container with the same bounded cleanup as a
    // timeout; it never leaves the dispatch unowned.
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let summary;
    try {
        summary = await runCampaign(requireRoot(options), {
            ...(options.slots.length === 0 ? {} : { slotIds: options.slots }),
            dryRun: options.dryRun,
            passthrough: options.passthrough,
            signal: controller.signal,
        });
    } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
    if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        for (const slotId of summary.ran) {
            console.log(`${options.dryRun ? "planned" : "ran"} ${slotId}`);
        }
        for (const problem of summary.problems) {
            console.error(`otc: ${problem}`);
        }
    }
    return summary.ok ? 0 : 1;
}

/** Blindly judge selected docs slots from checked evidence. */
async function judge(options: CliOptions): Promise<number> {
    const summary = await judgeCampaign(requireRoot(options), {
        ...(options.slots.length === 0 ? {} : { slotIds: options.slots }),
        dryRun: options.dryRun,
    });
    if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        for (const slotId of summary.judged) {
            console.log(
                `${options.dryRun ? "would judge" : "judged"} ${slotId}`,
            );
        }
        for (const slotId of summary.skipped) {
            console.log(`already judged ${slotId}`);
        }
        for (const problem of summary.problems) {
            console.error(`otc: ${problem}`);
        }
    }
    return summary.ok ? 0 : 1;
}

/** Deterministically assess captured evidence. */
function assess(options: CliOptions): number {
    const summary = assessCampaign(requireRoot(options), {
        ...(options.slots.length === 0 ? {} : { slotIds: options.slots }),
    });
    if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(
            `assessed ${summary.summary.assessed}: pass ${summary.summary.pass}, fail ${summary.summary.fail}, unknown ${summary.summary.unknown}, invalid ${summary.summary.invalid}, unrun ${summary.summary.unrun}`,
        );
        for (const skipped of summary.skipped) {
            console.log(skipped);
        }
        if (summary.stoppedAt !== null) {
            console.log(`stopped after ${summary.stoppedAt} by policy`);
        }
        for (const problem of summary.problems) {
            console.error(`otc: ${problem}`);
        }
    }
    return summary.ok ? 0 : 1;
}

/** Close the campaign ledger. */
function close(options: CliOptions): number {
    const closed = closeCampaign(requireRoot(options));
    if (!closed.ok) return fail(closed.problems, 1);
    console.log(
        closed.alreadyClosed
            ? `already closed at ${closed.closedAt}`
            : `closed at ${closed.closedAt}`,
    );
    return 0;
}

/** Render final analysis after closure. */
function analyse(options: CliOptions): number {
    const analysed = analyseCampaign(requireRoot(options), options.out ?? "");
    if (!analysed.ok) return fail(analysed.problems, 1);
    console.log(analysed.markdown);
    return 0;
}

/** Print checked, read-only status. */
function status(options: CliOptions): number {
    const status = statusOf(requireRoot(options));
    if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return status.state === "blocked" ? 1 : 0;
    }
    console.log(
        [
            `campaign ${status.campaignId ?? "unknown"} (${status.state})`,
            `slots ${status.counts.slots}; started ${status.counts.started}; assessed ${status.counts.assessed}`,
            ...(status.problems.length === 0
                ? []
                : [`problems: ${status.problems.join("; ")}`]),
            ...status.nextActions.map(
                (action) => `next: ${action.command} — ${action.reason}`,
            ),
        ].join("\n"),
    );
    return status.state === "blocked" ? 1 : 0;
}

/** Replay a recorded docs campaign through the checked docs evaluator. */
function replay(options: CliOptions): number {
    if (
        options.manifest === null ||
        options.evidenceRoot === null ||
        options.out === null
    ) {
        return fail(["replay needs --manifest, --evidence-root and --out"]);
    }
    const flags = [
        "--campaign",
        options.manifest,
        "--evidence-root",
        options.evidenceRoot,
        "--out",
        options.out,
        ...(options.rerender ? ["--rerender"] : []),
        ...(options.allowLegacyUnbound ? ["--allow-legacy-unbound"] : []),
    ];
    const result = runAnalysis(flags);
    for (const message of result.messages) console.log(message);
    return result.status;
}

/** The command dispatch table. */
const HANDLERS: Partial<
    Record<Command, (options: CliOptions) => number | Promise<number>>
> = {
    validate,
    prepare,
    "delivery-check": checkDelivery,
    freeze,
    run,
    judge,
    assess,
    close,
    analyse,
    status,
    replay,
};

const invokedDirectly =
    process.argv[1] !== undefined &&
    (() => {
        try {
            return (
                realpathSync(process.argv[1]) ===
                realpathSync(fileURLToPath(import.meta.url))
            );
        } catch {
            return false;
        }
    })();
if (invokedDirectly) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            console.error(
                error instanceof Error
                    ? (error.stack ?? String(error))
                    : String(error),
            );
            process.exitCode = 1;
        },
    );
}
