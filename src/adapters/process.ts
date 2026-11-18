import { spawn } from "node:child_process";

/** The bounded result of one child process. */
export interface CommandResult {
    /** The status value. */
    status: number | null;
    /** The signal value. */
    signal: NodeJS.Signals | null;
    /** The stdout value. */
    stdout: string;
    /** The stderr value. */
    stderr: string;
    /** The timed out value. */
    timedOut: boolean;
    /** The error value. */
    error: string | null;
    /**
     * Whether either captured stream exceeded its byte limit. An overflow is
     * deliberate truncation and never usable evidence.
     */
    overflowed?: boolean;
}

/** Limits for one process call. */
export interface CommandOptions {
    /** The cwd value. */
    cwd?: string;
    /** The env value. */
    env?: NodeJS.ProcessEnv;
    /** The timeout ms value. */
    timeoutMs?: number;
    /**
     * The byte limit applied to stdout and to stderr independently; defaults
     * to 64 MiB per stream. Exceeding it is reported, never silently absorbed.
     */
    maxBuffer?: number;
    /** The stdin value. */
    stdin?: "ignore" | "pipe";
    /**
     * Exact bytes written to the child's stdin before it runs. The stream is
     * closed immediately, so a reader such as `opencode run` sees a complete
     * prompt without any argument-vector size limit.
     */
    stdinText?: string;
    /** Cancels the child with the same bounded grace as a timeout. */
    signal?: AbortSignal;
}

/** The stdio triple for one child: stdin only when text is supplied. */
function stdioFor(
    options: CommandOptions,
): ["ignore" | "pipe", "pipe", "pipe"] {
    return [
        options.stdinText === undefined ? (options.stdin ?? "ignore") : "pipe",
        "pipe",
        "pipe",
    ];
}

/** Feed exact stdin text, tolerating a child that exits before reading. */
function feedStdin(
    child: ReturnType<typeof spawn>,
    text: string | undefined,
): void {
    if (text === undefined) return;
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(text);
}

/**
 * Wire one cancellation signal to bounded SIGTERM-then-SIGKILL.
 * @param child The running child.
 * @param signal The caller's cancellation signal.
 * @param settled Whether the call has already settled.
 * @returns The handler to detach, and any kill timer it set synchronously.
 */
function cancellationHook(
    child: ReturnType<typeof spawn>,
    signal: AbortSignal | undefined,
    settled: () => boolean,
): { handler: (() => void) | null; killTimer?: NodeJS.Timeout } {
    if (signal === undefined) return { handler: null };
    const handler = (): void => {
        if (settled()) return;
        child.kill("SIGTERM");
        setTimeout(() => {
            if (!settled()) child.kill("SIGKILL");
        }, 2_000);
    };
    if (signal.aborted) handler();
    else signal.addEventListener("abort", handler, { once: true });
    return { handler };
}

/** One captured stream, with an exact byte bound. */
interface Capture {
    /** Complete chunks accepted so far. */
    chunks: Buffer[];
    /** Bytes accepted so far. */
    bytes: number;
    /** Whether the cap was exceeded. */
    overflowed: boolean;
}

/** Decode complete bytes as UTF-8, never splitting a code point. */
function decode(capture: Capture): string {
    return new TextDecoder("utf-8").decode(Buffer.concat(capture.chunks));
}

/**
 * Run one child process without a shell, bounded in time and bytes. This is
 * the only place OTC spawns a process; adapters inject it so ordinary tests
 * never need Podman or OpenCode.
 *
 * The byte limit is per stream. A chunk that would cross it marks the capture
 * as overflowed and kills the child, so memory stays bounded and an
 * over-limit stream can never be mistaken for complete output.
 * @param command The executable.
 * @param args Its argv, verbatim.
 * @param options Working directory, environment, timeout and capture caps.
 * @returns The bounded result; a spawn failure is data, not an exception.
 */
export function runCommand(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
): Promise<CommandResult> {
    // Cancellation before launch must not create a child at all. Checking
    // after `spawn` would still pay for process creation and exec.
    if (options.signal?.aborted === true) {
        return Promise.resolve({
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            error: "not started: signal already aborted",
        });
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    return new Promise((resolvePromise) => {
        let settled = false;
        let timedOut = false;
        let overflowed = false;
        const out: Capture = { chunks: [], bytes: 0, overflowed: false };
        const err: Capture = { chunks: [], bytes: 0, overflowed: false };
        let timer: NodeJS.Timeout | null = null;
        let killTimer: NodeJS.Timeout | null = null;
        let onAbort: (() => void) | null = null;
        const clearTimers = (): void => {
            if (timer !== null) clearTimeout(timer);
            if (killTimer !== null) clearTimeout(killTimer);
        };
        const detachAbort = (): void => {
            if (onAbort !== null) {
                options.signal?.removeEventListener("abort", onAbort);
            }
        };
        const finish = (result: Partial<CommandResult>): void => {
            if (settled) return;
            settled = true;
            clearTimers();
            detachAbort();
            resolvePromise({
                status: result.status ?? null,
                signal: result.signal ?? null,
                stdout: result.stdout ?? decode(out),
                stderr: result.stderr ?? decode(err),
                timedOut,
                error: result.error ?? null,
                overflowed: overflowed || out.overflowed || err.overflowed,
            });
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, [...args], {
                cwd: options.cwd,
                env: options.env,
                stdio: stdioFor(options),
            });
        } catch (error) {
            finish({
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        feedStdin(child, options.stdinText);
        const append = (capture: Capture, chunk: Buffer | string): void => {
            if (capture.overflowed) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (capture.bytes + bytes.byteLength > maxBuffer) {
                capture.overflowed = true;
                overflowed = true;
                child.kill("SIGKILL");
                return;
            }
            capture.chunks.push(bytes);
            capture.bytes += bytes.byteLength;
        };
        child.stdout?.on("data", (chunk: Buffer | string) =>
            append(out, chunk),
        );
        child.stderr?.on("data", (chunk: Buffer | string) =>
            append(err, chunk),
        );
        child.on("error", (error) => finish({ error: error.message }));
        const cancellation = cancellationHook(
            child,
            options.signal,
            () => settled,
        );
        onAbort = cancellation.handler;
        if (cancellation.killTimer !== undefined) {
            killTimer = cancellation.killTimer;
        }
        timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
                if (!settled) child.kill("SIGKILL");
            }, 2_000);
        }, timeoutMs);
        child.on("close", (status, signal) => finish({ status, signal }));
    });
}
