import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../../src/adapters/process.ts";

/** Run a tiny node program that writes the given bytes. */
function node(script: string, options: Parameters<typeof runCommand>[2] = {}) {
    return runCommand(process.execPath, ["-e", script], options);
}

describe("bounded process capture", () => {
    it("accepts output exactly at the byte cap and rejects one byte over", async () => {
        // Arrange / Act
        const atCap = await node("process.stdout.write('abcd')", {
            maxBuffer: 4,
        });
        const overCap = await node("process.stdout.write('abcde')", {
            maxBuffer: 4,
        });

        // Assert
        assert.equal(atCap.stdout, "abcd");
        assert.equal(atCap.overflowed, false);
        assert.equal(overCap.overflowed, true);
        assert.equal(
            overCap.stdout,
            "",
            "an over-cap stream is not a usable capture",
        );
    });

    it("never silently discards a later chunk", async () => {
        // Arrange: four chunks of four bytes against a six-byte cap.
        const script =
            "for (const part of ['aaaa','bbbb','cccc','dddd']) process.stdout.write(part)";

        // Act
        const result = await node(script, { maxBuffer: 6 });

        // Assert
        assert.equal(result.overflowed, true);
        assert.equal(result.stdout.length <= 6, true);
    });

    it("applies the byte cap to each stream independently", async () => {
        // Arrange
        const script =
            "process.stdout.write('1234'); process.stderr.write('123456')";

        // Act
        const result = await node(script, { maxBuffer: 4 });

        // Assert
        assert.equal(result.stdout, "1234");
        assert.equal(result.overflowed, true, "stderr exceeded its own cap");
    });

    it("joins a multibyte character split across chunks", async () => {
        // Arrange: the four bytes of 😀 are written in two chunks.
        const script =
            "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98,0x80])), 20)";

        // Act
        const result = await node(script);

        // Assert
        assert.equal(result.stdout, "😀");
        assert.equal(result.overflowed, false);
    });

    it("reports an incomplete final UTF-8 sequence without throwing", async () => {
        // Arrange: "f" followed by a lone continuation byte.
        const script = "process.stdout.write(Buffer.from([0x66,0x80]))";

        // Act
        const result = await node(script);

        // Assert
        assert.match(result.stdout, /^f\uFFFD$/);
        assert.equal(result.error, null);
    });

    it("distinguishes zero output from an error", async () => {
        // Arrange / Act
        const zero = await node("");

        // Assert
        assert.equal(zero.stdout, "");
        assert.equal(zero.stderr, "");
        assert.equal(zero.status, 0);
        assert.equal(zero.error, null);
        assert.equal(zero.overflowed, false);
    });

    it("returns a spawn failure as data", async () => {
        // Arrange / Act
        const result = await runCommand("/nonexistent/otc-probe", []);

        // Assert
        assert.equal(result.status, null);
        assert.match(result.error ?? "", /ENOENT|not found/);
        assert.equal(result.overflowed, false);
    });

    it("cancels a running child on an abort signal", async () => {
        // Arrange
        const controller = new AbortController();
        const pending = node("setTimeout(() => {}, 5000)", {
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 50);

        // Act
        const result = await pending;

        // Assert
        assert.equal(result.timedOut, false, "cancellation is not a timeout");
        assert.equal(
            result.signal === null,
            false,
            "the child was not signalled",
        );
    });

    it("bounds a timeout and terminates the child", async () => {
        // Arrange
        const started = Date.now();
        const script = "setTimeout(() => {}, 5000)";

        // Act
        const result = await node(script, { timeoutMs: 50 });

        // Assert
        assert.equal(result.timedOut, true);
        assert.equal(result.status === null || result.signal !== null, true);
        assert.equal(Date.now() - started < 3000, true);
    });
});

describe("stdin transport", () => {
    it("delivers exact text larger than the argument limit", async () => {
        // Arrange: 200 KiB is above the host's ordinary single-argument cap.
        const payload = `BEGIN${"x".repeat(200 * 1024)}END`;

        // Act
        const result = await runCommand(
            process.execPath,
            [
                "-e",
                "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(String(s.length)+':'+s.slice(0,5)+s.slice(-3)))",
            ],
            { stdinText: payload, timeoutMs: 20_000 },
        );

        // Assert
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${String(payload.length)}:BEGINEND`);
    });

    it("reports a child that never reads stdin without hanging", async () => {
        // Act
        const result = await runCommand(
            process.execPath,
            ["-e", "process.exit(0)"],
            {
                stdinText: "ignored",
                timeoutMs: 20_000,
            },
        );

        // Assert
        assert.equal(result.status, 0);
        assert.equal(result.timedOut, false);
    });
});
