import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTrialPlan } from "../../src/campaign/run.ts";
import { buildAttemptPlan } from "../../src/campaign/judge.ts";
import type { ContainerPlan } from "../../src/adapters/podman/container.ts";

const IMAGE = `sha256:${"c".repeat(64)}`;

/** Deep-freeze a value so a builder that mutates its input throws. */
function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) deepFreeze(entry);
        Object.freeze(value);
    }
    return value;
}

describe("plan builders", () => {
    it("builds a complete trial plan from explicit values", () => {
        // Arrange
        const values = deepFreeze({
            imageId: IMAGE,
            workspace: "/staged/workspace",
            configHome: "/staged/config-home",
            subjects: "/staged/subjects",
            journal: "/staged/journal",
            workdir: "/workspace",
            network: "none" as const,
            argv: ["opencode", "run", "--prompt", "hello"],
            envFile: "/staged/trial.env",
            envNames: ["HOME", "HOME", "XDG_DATA_HOME"],
            timeoutMs: 1234,
            name: "otc-owned-name",
            labels: { "otc.owner": "otc", "otc.slot": "s1" },
        });

        // Act
        const plan = buildTrialPlan(values);

        // Assert
        assert.equal(plan.imageId, IMAGE);
        assert.equal(plan.workdir, "/workspace");
        assert.equal(plan.network, "none");
        assert.equal(plan.timeoutMs, 1234);
        assert.equal(plan.name, "otc-owned-name");
        assert.deepEqual(plan.argv, [...values.argv]);
        assert.deepEqual(plan.envNames, ["HOME", "XDG_DATA_HOME"]);
        assert.equal(plan.envFile, "/staged/trial.env");
        assert.deepEqual(plan.labels, values.labels);
        assert.deepEqual(
            plan.mounts.map((mount) => ({
                target: mount.target,
                readOnly: mount.readOnly,
            })),
            [
                { target: "/workspace", readOnly: false },
                { target: "/config-home", readOnly: true },
                { target: "/subjects", readOnly: true },
                { target: "/journal", readOnly: false },
            ],
        );
        assert.equal(plan.stdin, undefined);
    });

    it("omits the journal mount when the case has none", () => {
        // Arrange
        const values = {
            imageId: IMAGE,
            workspace: "/workspace",
            configHome: "/config-home",
            subjects: "/subjects",
            journal: null,
            workdir: "/workspace",
            network: "host" as const,
            argv: ["opencode"],
            envFile: "/trial.env",
            envNames: ["HOME"],
            timeoutMs: 10,
            name: "owned",
            labels: {},
        };

        // Act
        const plan = buildTrialPlan(values);

        // Assert
        assert.equal(
            plan.mounts.some((mount) => mount.target === "/journal"),
            false,
        );
    });

    it("builds the judge attempt plan with its packet on stdin", () => {
        // Arrange
        const values = deepFreeze({
            imageId: IMAGE,
            packet: "PACKET-BYTES",
            packetFile: "/staged/judge/packet.md",
            configHome: "/staged/judge/config-home",
            work: "/staged/judge/work",
            network: "none" as const,
            argv: ["opencode", "--model", "judge-model"],
            envFile: "/staged/judge/judge.env",
            envNames: ["HOME", "XDG_CACHE_HOME"],
            timeoutMs: 4321,
            name: "otc-judge-owned",
            labels: {
                "otc.owner": "otc",
                "otc.judge": "1",
                "otc.attempt": "attempt-001",
            },
        });

        // Act
        const plan = buildAttemptPlan(values);

        // Assert
        assert.equal(plan.imageId, IMAGE);
        assert.equal(plan.workdir, "/judge/work");
        assert.equal(plan.timeoutMs, 4321);
        assert.equal(plan.stdin, "PACKET-BYTES");
        assert.equal(plan.envFile, "/staged/judge/judge.env");
        assert.deepEqual(plan.envNames, ["HOME", "XDG_CACHE_HOME"]);
        assert.deepEqual(plan.argv, [...values.argv]);
        assert.deepEqual(plan.labels, values.labels);
        assert.deepEqual(
            plan.mounts.map((mount) => ({
                target: mount.target,
                readOnly: mount.readOnly,
            })),
            [
                { target: "/judge/packet.md", readOnly: true },
                { target: "/config-home", readOnly: true },
                { target: "/judge/work", readOnly: false },
            ],
        );
        for (const argument of plan.argv) {
            assert.equal(argument.includes("PACKET-BYTES"), false);
        }
    });

    it("does not retain or mutate the caller's arrays and labels", () => {
        // Arrange
        const argv = ["opencode"];
        const envNames = ["HOME"];
        const labels: Record<string, string> = { "otc.owner": "otc" };
        const values = {
            imageId: IMAGE,
            packet: "packet",
            packetFile: "/packet.md",
            configHome: "/config-home",
            work: "/work",
            network: "none" as const,
            argv,
            envFile: "/judge.env",
            envNames,
            timeoutMs: 1,
            name: "owned",
            labels,
        };

        // Act
        const first = buildAttemptPlan(values);
        argv.push("mutated");
        envNames.push("MUTATED");
        labels["otc.owner"] = "mutated";

        // Assert
        assert.deepEqual(first.argv, ["opencode"]);
        assert.deepEqual(first.envNames, ["HOME"]);
        assert.deepEqual(first.labels, { "otc.owner": "otc" });
        const plan: ContainerPlan = first;
        assert.equal(plan.imageId, IMAGE);
    });
});
