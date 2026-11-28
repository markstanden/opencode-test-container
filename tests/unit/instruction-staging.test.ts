import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    prepareCampaign,
    type PreparedManifest,
    type StagedArm,
} from "../../src/campaign/prepare.ts";
import { freezeCampaign, loadFrozen } from "../../src/campaign/freeze.ts";
import { planTrial, runCampaign } from "../../src/campaign/run.ts";
import type { CommandResult } from "../../src/adapters/process.ts";
import type { SuiteCase } from "../../src/contracts/types.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** A fake process adapter that resolves image identity and CLI version. */
const fakeImage = async (
    command: string,
    args: readonly string[],
): Promise<CommandResult> => {
    assert.equal(command, "podman");
    return {
        status: 0,
        signal: null,
        stdout: args.includes("inspect")
            ? `${IMAGE_ID}\n`
            : "opencode v2.2.6\n",
        stderr: "",
        timedOut: false,
        error: null,
    };
};

/** Write one file, creating parents. */
function write(path: string, contents: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents, "utf8");
}

interface Scenario {
    /** Whether the suite case ships a fixture directory. */
    fixture: boolean;
    /** Whether that fixture contains AGENTS.md. */
    fixtureAgents: boolean;
    /** Whether the case's inline files create AGENTS.md. */
    inline: boolean;
    /** The arm instruction's bytes, or null for no instruction. */
    instruction: string | null;
    /** Extra file in the fixture, to prove shared context survives. */
    extraFixtureFile?: boolean;
}

interface Prepared {
    dir: string;
    root: string;
    manifest: PreparedManifest;
    frozen: Parameters<typeof planTrial>[0]["frozen"];
    caseValue: SuiteCase;
    arm: StagedArm;
}

/** Prepare one small campaign with the requested collision shape. */
async function prepared(scenario: Scenario): Promise<Prepared> {
    const dir = mkdtempSync(join(tmpdir(), "otc-staging-"));
    write(join(dir, "skills", "otel-helper", "SKILL.md"), "skill body\n");
    if (scenario.fixture) {
        if (scenario.fixtureAgents) {
            write(join(dir, "fixture", "AGENTS.md"), "fixture guidance\n");
        }
        if (scenario.extraFixtureFile !== false) {
            write(
                join(dir, "fixture", "src", "app.ts"),
                "export const app = 1;\n",
            );
        }
    }
    write(
        join(dir, "arms", "guidance", "AGENTS.md"),
        scenario.instruction ?? "",
    );
    const testCase = {
        caseId: "c1",
        kind: "skill-trigger",
        targetSkillId: "otel-helper",
        expected: "activation",
        prompt: "Instrument the checkout service.",
        ...(scenario.fixture ? { fixture: "fixture" } : {}),
        ...(scenario.inline
            ? { files: { "AGENTS.md": "inline guidance\n" } }
            : {}),
    };
    write(
        join(dir, "suite.json"),
        `${JSON.stringify({
            schemaVersion: 1,
            suiteId: "staging",
            assessment: "skill-activation",
            cases: [testCase],
        })}\n`,
    );
    write(
        join(dir, "campaign.json"),
        `${JSON.stringify({
            schemaVersion: 1,
            campaignId: "staging",
            suite: { path: "suite.json" },
            subjects: [
                {
                    armId: "skill-only",
                    skills: [{ id: "otel-helper", path: "skills/otel-helper" }],
                    ...(scenario.instruction === null
                        ? {}
                        : {
                              instructions: [
                                  {
                                      id: "guidance",
                                      path: "arms/guidance/AGENTS.md",
                                  },
                              ],
                          }),
                },
            ],
            schedule: {
                kind: "explicit",
                slots: [
                    {
                        slotId: "s1",
                        caseId: "c1",
                        armId: "skill-only",
                        repetitionId: "r0",
                    },
                ],
            },
            runtime: {
                image: "localhost/otc-sandbox:2.2.6",
                opencodeVersion: "2.2.6",
                provider: { route: "scripted", model: "p/m" },
                timeoutMs: 1000,
                network: "host",
            },
            budgets: { trials: 1, judgeAttempts: 0 },
            assessment: { kind: "skill-activation" },
        })}\n`,
    );
    const root = join(dir, "root");
    const result = prepareCampaign(join(dir, "campaign.json"), root);
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
    if (!result.ok) throw new Error("prepare failed");
    const frozen = await freezeCampaign(root, fakeImage as never);
    assert.equal(frozen.ok, true, frozen.ok ? "" : frozen.problems.join("; "));
    if (!frozen.ok) throw new Error("freeze failed");
    const loaded = loadFrozen(root);
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.problem);
    if (!loaded.ok) throw new Error("frozen receipt unreadable");
    const caseValue = result.manifest.suite.cases[0];
    const arm = result.manifest.subjects[0];
    assert.ok(caseValue !== undefined && arm !== undefined);
    return {
        dir,
        root,
        manifest: result.manifest,
        frozen: loaded.record,
        caseValue,
        arm,
    };
}

/** Plan one slot into a test-owned trial directory. */
function plan(value: Prepared, trialDir: string) {
    return planTrial({
        root: value.root,
        manifest: value.manifest,
        frozen: value.frozen,
        slot: {
            slotId: "s1",
            caseId: "c1",
            armId: "skill-only",
            repetitionId: "r0",
        },
        testCase: value.caseValue,
        arm: value.arm,
        trialDir,
    });
}

describe("arm instruction staging", () => {
    it("refuses an arm instruction when the fixture already ships AGENTS.md", async () => {
        const value = await prepared({
            fixture: true,
            fixtureAgents: true,
            inline: false,
            instruction: "arm guidance\n",
        });
        const summary = await runCampaign(
            value.root,
            { dryRun: true },
            {
                runContainer: async () => {
                    throw new Error("dry run started a container");
                },
            },
        );

        assert.equal(summary.ok, false);
        assert.ok(
            summary.problems.some((problem) =>
                problem.includes(
                    "instruction guidance collides with AGENTS.md",
                ),
            ),
            summary.problems.join("; "),
        );
        assert.equal(
            existsSync(join(value.root, "evidence", "trials")),
            false,
            "a colliding dry run must not start a trial",
        );
        rmSync(value.dir, { recursive: true, force: true });
    });

    it("refuses an arm instruction when case.files already created AGENTS.md", async () => {
        const value = await prepared({
            fixture: true,
            fixtureAgents: true,
            inline: true,
            instruction: "arm guidance\n",
        });
        const trialDir = mkdtempSync(join(tmpdir(), "otc-plan-"));
        const planned = plan(value, trialDir);

        assert.equal(planned.ok, false);
        assert.ok(
            planned.problems.some((problem) =>
                problem.includes(
                    "instruction guidance collides with AGENTS.md",
                ),
            ),
            planned.problems.join("; "),
        );
        rmSync(trialDir, { recursive: true, force: true });
        rmSync(value.dir, { recursive: true, force: true });
    });

    it("stages exactly the arm's bytes when nothing else owns AGENTS.md", async () => {
        const value = await prepared({
            fixture: true,
            fixtureAgents: false,
            inline: false,
            instruction: "arm guidance\n",
        });
        const trialDir = mkdtempSync(join(tmpdir(), "otc-plan-"));
        const planned = plan(value, trialDir);

        assert.equal(
            planned.ok,
            true,
            planned.ok ? "" : planned.problems.join("; "),
        );
        assert.equal(
            readFileSync(join(trialDir, "workspace", "AGENTS.md"), "utf8"),
            "arm guidance\n",
        );
        rmSync(trialDir, { recursive: true, force: true });
        rmSync(value.dir, { recursive: true, force: true });
    });

    it("keeps inline bytes over a fixture AGENTS.md when no instruction collides", async () => {
        const value = await prepared({
            fixture: true,
            fixtureAgents: true,
            inline: true,
            instruction: null,
        });

        assert.equal(
            readFileSync(
                join(value.root, "prepare", "workspaces", "c1", "AGENTS.md"),
                "utf8",
            ),
            "inline guidance\n",
        );
        rmSync(value.dir, { recursive: true, force: true });
    });

    it("stages different guidance per arm over one identical fixture and skill", async () => {
        const dir = mkdtempSync(join(tmpdir(), "otc-staging-ab-"));
        write(join(dir, "skills", "otel-helper", "SKILL.md"), "skill body\n");
        write(join(dir, "fixture", "src", "app.ts"), "export const app = 1;\n");
        for (const arm of ["before", "after"]) {
            write(join(dir, "arms", arm, "AGENTS.md"), `${arm} guidance\n`);
        }
        const testCase = {
            caseId: "c1",
            kind: "skill-trigger",
            targetSkillId: "otel-helper",
            expected: "activation",
            prompt: "Instrument the checkout service.",
            fixture: "fixture",
        };
        write(
            join(dir, "suite.json"),
            `${JSON.stringify({
                schemaVersion: 1,
                suiteId: "staging-ab",
                assessment: "skill-activation",
                cases: [testCase],
            })}\n`,
        );
        write(
            join(dir, "campaign.json"),
            `${JSON.stringify({
                schemaVersion: 1,
                campaignId: "staging-ab",
                suite: { path: "suite.json" },
                subjects: ["before", "after"].map((arm) => ({
                    armId: arm,
                    skills: [{ id: "otel-helper", path: "skills/otel-helper" }],
                    instructions: [
                        {
                            id: "guidance",
                            path: `arms/${arm}/AGENTS.md`,
                        },
                    ],
                })),
                schedule: {
                    kind: "explicit",
                    slots: ["before", "after"].map((arm) => ({
                        slotId: `${arm}-s1`,
                        caseId: "c1",
                        armId: arm,
                        repetitionId: "r0",
                    })),
                },
                runtime: {
                    image: "localhost/otc-sandbox:2.2.6",
                    opencodeVersion: "2.2.6",
                    provider: { route: "scripted", model: "p/m" },
                    timeoutMs: 1000,
                    network: "host",
                },
                budgets: { trials: 2, judgeAttempts: 0 },
                assessment: { kind: "skill-activation" },
            })}\n`,
        );
        const root = join(dir, "root");
        const result = prepareCampaign(join(dir, "campaign.json"), root);
        assert.equal(
            result.ok,
            true,
            result.ok ? "" : result.problems.join("; "),
        );
        if (!result.ok) return;
        const frozen = await freezeCampaign(root, fakeImage as never);
        assert.equal(
            frozen.ok,
            true,
            frozen.ok ? "" : frozen.problems.join("; "),
        );
        if (!frozen.ok) return;
        const loaded = loadFrozen(root);
        assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.problem);
        if (!loaded.ok) return;
        const caseValue = result.manifest.suite.cases[0];
        assert.ok(caseValue !== undefined);

        const staged = new Map<
            string,
            { guidance: string; skill: string; fixture: string }
        >();
        for (const armId of ["before", "after"]) {
            const arm: StagedArm | undefined = result.manifest.subjects.find(
                (entry) => entry.armId === armId,
            );
            assert.ok(arm !== undefined);
            const trialDir = mkdtempSync(join(tmpdir(), "otc-plan-"));
            const planned = planTrial({
                root,
                manifest: result.manifest,
                frozen: loaded.record,
                slot: {
                    slotId: `${armId}-s1`,
                    caseId: "c1",
                    armId,
                    repetitionId: "r0",
                },
                testCase: caseValue,
                arm,
                trialDir,
            });
            assert.equal(
                planned.ok,
                true,
                planned.ok ? "" : planned.problems.join("; "),
            );
            staged.set(armId, {
                guidance: readFileSync(
                    join(trialDir, "workspace", "AGENTS.md"),
                    "utf8",
                ),
                skill: readFileSync(
                    join(
                        trialDir,
                        "config-home",
                        "opencode",
                        "skills",
                        "otel-helper",
                        "SKILL.md",
                    ),
                    "utf8",
                ),
                fixture: readFileSync(
                    join(trialDir, "workspace", "src", "app.ts"),
                    "utf8",
                ),
            });
            rmSync(trialDir, { recursive: true, force: true });
        }

        assert.equal(staged.get("before")?.guidance, "before guidance\n");
        assert.equal(staged.get("after")?.guidance, "after guidance\n");
        assert.equal(staged.get("before")?.skill, staged.get("after")?.skill);
        assert.equal(
            staged.get("before")?.fixture,
            staged.get("after")?.fixture,
        );
        rmSync(dir, { recursive: true, force: true });
    });
});
