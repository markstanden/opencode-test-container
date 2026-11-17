import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    loadPreparedManifest,
    prepareCampaign,
} from "../../src/campaign/prepare.ts";
import { freezeCampaign, loadFrozen } from "../../src/campaign/freeze.ts";
import {
    runCampaign,
    planTrial,
    trialDirectory,
} from "../../src/campaign/run.ts";
import { closeCampaign } from "../../src/campaign/close.ts";
import {
    containerArgv,
    cleanupContainer,
    mountProblems,
    ownedContainerName,
    type ContainerPlan,
} from "../../src/adapters/podman/container.ts";
import {
    environmentFileProblems,
    environmentFileText,
} from "../../src/adapters/opencode/runtime.ts";
import {
    environmentNameProblem,
    environmentValueProblem,
} from "../../src/contracts/env.ts";
import { runCommand, type CommandResult } from "../../src/adapters/process.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");
const IMAGE_ID = `sha256:${"3".repeat(64)}`;

const fakeImage = async (
    command: string,
    args: readonly string[],
): Promise<CommandResult> => {
    assert.equal(command, "podman");
    return args.includes("inspect")
        ? {
              status: 0,
              signal: null,
              stdout: `${IMAGE_ID}\n`,
              stderr: "",
              timedOut: false,
              error: null,
          }
        : {
              status: 0,
              signal: null,
              stdout: "opencode v2.2.6\n",
              stderr: "",
              timedOut: false,
              error: null,
          };
};

/** A frozen root. */
async function frozenRoot(): Promise<{ dir: string; root: string }> {
    const dir = mkdtempSync(join(tmpdir(), "otc-env-"));
    cpSync(FIXTURE, dir, { recursive: true });
    const root = join(dir, "root");
    const prepared = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(
        prepared.ok,
        true,
        prepared.ok ? "" : prepared.problems.join("; "),
    );
    const frozen = await freezeCampaign(root, fakeImage as typeof runCommand);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    return { dir, root };
}

describe("environment rules", () => {
    const dirs: string[] = [];
    after(() => {
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    it("rejects invalid and reserved names without echoing values", () => {
        // Arrange
        const secret = "SUPERSECRET_VALUE";

        // Act
        const invalid = environmentNameProblem("not a name");
        const home = environmentNameProblem("HOME");
        const xdg = environmentNameProblem("XDG_CONFIG_HOME");
        const journal = environmentNameProblem("DOCS_OPERATION_JOURNAL_KEY");
        const newline = environmentValueProblem("TOKEN", `${secret}\nmore`);

        // Assert
        assert.match(invalid ?? "", /not a valid environment name/);
        assert.match(home ?? "", /reserved/);
        assert.match(xdg ?? "", /reserved/);
        assert.match(journal ?? "", /reserved/);
        assert.match(newline ?? "", /newline|carriage|NUL/);
        assert.equal((newline ?? "").includes(secret), false);
    });

    it("refuses a campaign that tries to override an OTC-owned variable", async () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-env-campaign-"));
        dirs.push(dir);
        cpSync(FIXTURE, dir, { recursive: true });
        const campaignPath = join(dir, "campaign.json");
        const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
            runtime: Record<string, unknown>;
        };
        campaign.runtime.passthroughEnv = ["HOME"];
        writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`);

        // Act
        const prepared = prepareCampaign(campaignPath, join(dir, "root"));

        // Assert
        assert.equal(prepared.ok, false);
        assert.match(
            prepared.ok ? "" : prepared.problems.join("; "),
            /reserved by OTC/,
        );
    });

    it("refuses a value containing a newline when planning a trial", async () => {
        // Arrange
        const { dir, root } = await frozenRoot();
        dirs.push(dir);
        process.env.OTC_TEST_UNSAFE = "line\nbreak";
        try {
            const prepared = loadPreparedManifest(root);
            const frozen = loadFrozen(root);
            assert.equal(prepared.ok, true);
            assert.equal(frozen.ok, true);
            if (!prepared.ok || !frozen.ok) return;
            const slot = prepared.manifest.campaign.schedule.slots[0]!;
            const testCase = prepared.manifest.suite.cases[0]!;
            const arm = prepared.manifest.subjects[0]!;

            // Act
            const planned = planTrial({
                root,
                manifest: prepared.manifest,
                frozen: frozen.record,
                slot,
                testCase,
                arm,
                trialDir: trialDirectory(root, slot.slotId),
                passthrough: ["OTC_TEST_UNSAFE"],
            });

            // Assert
            assert.equal(planned.ok, false);
            assert.match(
                planned.ok ? "" : planned.problems.join("; "),
                /OTC_TEST_UNSAFE contains a newline/,
            );
            assert.equal(
                (planned.ok ? "" : planned.problems.join("; ")).includes(
                    "line\nbreak",
                ),
                false,
            );
        } finally {
            delete process.env.OTC_TEST_UNSAFE;
        }
    });

    it("writes only the selected names", () => {
        // Arrange
        const env = { A: "1", B: "2" };

        // Act
        const text = environmentFileText(env, ["A"]);
        const problems = environmentFileProblems(env, ["A", "B"], ["C"]);

        // Assert
        assert.equal(text, "A=1\n");
        assert.deepEqual(problems, []);
    });
});

describe("container ownership and mount syntax", () => {
    it("passes an owned name and labels, and rejects comma/NUL sources", () => {
        // Arrange
        const plan: ContainerPlan = {
            imageId: IMAGE_ID,
            mounts: [],
            workdir: "/workspace",
            network: "none",
            argv: ["opencode", "run"],
            envNames: [],
            envFile: null,
            timeoutMs: 1000,
            name: ownedContainerName("camp", "s1", "abc123"),
            labels: { "otc.owner": "otc", "otc.slot": "s1" },
        };

        // Act
        const argv = containerArgv(plan);
        const comma = mountProblems([
            { source: "/tmp/a,b", target: "/workspace", readOnly: false },
        ]);
        const nul = mountProblems([
            { source: "/tmp/a\0b", target: "/workspace", readOnly: false },
        ]);

        // Assert
        assert.ok(argv.includes("--name"));
        assert.ok(argv.includes(plan.name ?? ""));
        assert.ok(argv.includes("otc.slot=s1"));
        assert.match(comma.join("; "), /may not contain a comma/);
        assert.match(nul.join("; "), /may not contain a NUL/);
    });

    it("cleans up only its owned name after a timeout", async () => {
        // Arrange
        const calls: string[][] = [];
        const run = async (
            command: string,
            args: readonly string[],
            _options?: import("../../src/adapters/process.ts").CommandOptions,
        ): Promise<CommandResult> => {
            calls.push([command, ...args]);
            return {
                status: null,
                signal: "SIGTERM",
                stdout: "",
                stderr: "",
                timedOut: true,
                error: null,
            };
        };

        // Act
        await cleanupContainer("otc-owned-1", run);

        // Assert
        assert.deepEqual(calls, [
            ["podman", "stop", "-t", "2", "otc-owned-1"],
            ["podman", "rm", "-f", "otc-owned-1"],
        ]);
    });

    it("removes the trial env file and keeps the claim when the runner throws", async () => {
        // Arrange
        const { dir, root } = await frozenRoot();
        try {
            // Act
            await assert.rejects(
                runCampaign(
                    root,
                    { slotIds: ["s1"] },
                    {
                        runContainer: async () => {
                            throw new Error("runner exploded");
                        },
                    },
                ),
                /runner exploded/,
            );

            // Assert
            const trial = trialDirectory(root, "s1");
            assert.equal(existsSync(join(trial, "trial.env")), false);
            assert.equal(existsSync(join(trial, "launch.json")), true);
            const claims = execFileSync(
                "find",
                [join(root, "evidence", "trial"), "-name", "*.claim"],
                { encoding: "utf8" },
            ).trim();
            assert.notEqual(claims, "");
            const claim = JSON.parse(
                readFileSync(claims.split("\n")[0]!, "utf8"),
            ) as {
                state: string;
            };
            assert.equal(claim.state, "spawned");
            assert.equal(closeCampaign(root).ok, false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
