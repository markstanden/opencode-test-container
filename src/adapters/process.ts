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
}

/** Limits for one process call. */
export interface CommandOptions {
    /** The cwd value. */
    cwd?: string;
    /** The env value. */
    env?: NodeJS.ProcessEnv;
    /** The timeout ms value. */
    timeoutMs?: number;
    /** The max buffer value. */
    maxBuffer?: number;
    /** The stdin value. */
    stdin?: "ignore" | "pipe";
}

/**
 * Run one child process without a shell, bounded in time and output. This is
 * the only place OTC spawns a process; adapters inject it so ordinary tests
 * never need Podman or OpenCode.
 * @param command The executable.
 * @param args Its argv, verbatim.
 * @param options Working directory, environment, timeout and capture cap.
 * @returns The bounded result; a spawn failure is data, not an exception.
 */
export function runCommand(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    return new Promise((resolvePromise) => {
        let settled = false;
        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let timer: NodeJS.Timeout | null = null;
        const finish = (result: Partial<CommandResult>): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            resolvePromise({
                status: result.status ?? null,
                signal: result.signal ?? null,
                stdout: result.stdout ?? stdout,
                stderr: result.stderr ?? stderr,
                timedOut,
                error: result.error ?? null,
            });
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(command, [...args], {
                cwd: options.cwd,
                env: options.env,
                stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
            });
        } catch (error) {
            finish({
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        const append = (
            stream: "out" | "err",
            chunk: Buffer | string,
        ): void => {
            if (stream === "out") {
                if (stdout.length < maxBuffer) stdout += String(chunk);
            } else if (stderr.length < maxBuffer) {
                stderr += String(chunk);
            }
        };
        child.stdout?.on("data", (chunk: Buffer | string) =>
            append("out", chunk),
        );
        child.stderr?.on("data", (chunk: Buffer | string) =>
            append("err", chunk),
        );
        child.on("error", (error) => finish({ error: error.message }));
        timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => {
                if (!settled) child.kill("SIGKILL");
            }, 2_000);
        }, timeoutMs);
        child.on("close", (status, signal) =>
            finish({ status, signal, stdout, stderr }),
        );
    });
}
