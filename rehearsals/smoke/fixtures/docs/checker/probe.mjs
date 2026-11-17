import { writeFileSync } from "node:fs";
import { connect } from "node:net";
const port = Number("{{CHECKER_PORT}}");
const out = {
    canWriteLive: (() => {
        try {
            writeFileSync("/live/checker-write.txt", "x");
            return true;
        } catch {
            return false;
        }
    })(),
    canWritePristine: (() => {
        try {
            writeFileSync("/pristine/checker-write.txt", "x");
            return true;
        } catch {
            return false;
        }
    })(),
    canWriteChecker: (() => {
        try {
            writeFileSync("/checker/checker-write.txt", "x");
            return true;
        } catch {
            return false;
        }
    })(),
    hasProviderCredentials: [
        "ZAI_API_KEY",
        "OPENCODE_CONFIG_CONTENT",
        "DOCS_OPERATION_JOURNAL_KEY",
    ].filter((name) => process.env[name] !== undefined),
    network: await new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => {
            socket.destroy();
            resolve("timeout");
        }, 1200);
        socket.on("connect", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve("connected");
        });
        socket.on("error", () => {
            clearTimeout(timer);
            resolve("refused");
        });
    }),
};
console.log(JSON.stringify(out));
