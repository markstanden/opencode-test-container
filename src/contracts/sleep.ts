/** A bounded synchronous pause, used only for short filesystem arbitration. */
export function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
