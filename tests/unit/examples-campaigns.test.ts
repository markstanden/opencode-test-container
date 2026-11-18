import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { loadCampaignBundle } from "../../src/contracts/validate.ts";
import { prepareCampaign } from "../../src/campaign/prepare.ts";
import { freezeCampaign } from "../../src/campaign/freeze.ts";
import { runCampaign } from "../../src/campaign/run.ts";
import type { CommandResult } from "../../src/adapters/process.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** Every campaign document shipped under examples/. */
function exampleCampaigns(): string[] {
    const examples = join(repoRoot, "examples");
    return readdirSync(examples, { recursive: true, withFileTypes: true })
        .filter(
            (entry) =>
                entry.isFile() &&
                entry.name.startsWith("campaign") &&
                entry.name.endsWith(".json"),
        )
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

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

/** The shipped repetition campaign, which the trigger-rate recipe starts from. */
const repetitions = join(
    repoRoot,
    "examples",
    "skills",
    "campaign-repetitions.json",
);

describe("shipped example campaigns", () => {
    it("finds at least one campaign to validate", () => {
        assert.ok(exampleCampaigns().length > 0);
    });

    for (const campaignPath of exampleCampaigns()) {
        it(`${relative(repoRoot, campaignPath)} validates with its suite`, () => {
            const loaded = loadCampaignBundle(campaignPath);

            assert.deepEqual(
                loaded.ok ? [] : loaded.problems,
                [],
                `${relative(repoRoot, campaignPath)} does not validate`,
            );
        });
    }

    for (const campaignPath of exampleCampaigns()) {
        it(`${relative(repoRoot, campaignPath)} has no dangling slots or skills`, () => {
            const loaded = loadCampaignBundle(campaignPath);
            assert.equal(loaded.ok, true);
            if (!loaded.ok) return;
            const { campaign, suite } = loaded.value;
            const caseIds = new Set(suite.cases.map((entry) => entry.caseId));
            const armIds = new Set(
                campaign.subjects.map((entry) => entry.armId),
            );

            for (const slot of campaign.schedule.slots) {
                assert.ok(
                    caseIds.has(slot.caseId),
                    `${slot.slotId} names unknown case ${slot.caseId}`,
                );
                assert.ok(
                    armIds.has(slot.armId),
                    `${slot.slotId} names unknown arm ${slot.armId}`,
                );
            }
            for (const arm of campaign.subjects) {
                for (const skill of arm.skills ?? []) {
                    assert.ok(
                        existsSync(join(skill.path, "SKILL.md")),
                        `${arm.armId} skill ${skill.id} has no resolvable SKILL.md`,
                    );
                }
            }
            assert.ok(
                campaign.budgets.trials <= campaign.schedule.slots.length,
                `${relative(repoRoot, campaignPath)} budgets more trials than slots`,
            );
        });
    }

    it("ships three repetitions of each of the three cases", () => {
        const loaded = loadCampaignBundle(repetitions);
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;
        const { campaign, suite } = loaded.value;

        assert.equal(campaign.schedule.slots.length, 9);
        assert.equal(campaign.budgets.trials, 9);
        const counts = new Map<string, number>();
        for (const slot of campaign.schedule.slots) {
            counts.set(slot.caseId, (counts.get(slot.caseId) ?? 0) + 1);
        }
        assert.deepEqual([...counts.keys()].sort(), [
            "negative-near-miss",
            "negative-unrelated",
            "positive-instrument",
        ]);
        assert.deepEqual(
            [...counts.values()],
            [3, 3, 3],
            "each shipped case should have three slots",
        );
        assert.equal(suite.cases.length, 3);
    });
});

describe("shipped example workspaces", () => {
    it("stages the suite-relative fixture from a different working directory", () => {
        const elsewhere = mkdtempSync(join(tmpdir(), "otc-elsewhere-"));
        const root = join(elsewhere, "root");
        const previous = process.cwd();
        try {
            process.chdir(elsewhere);
            const prepared = prepareCampaign(
                join(repoRoot, "examples", "skills", "campaign.json"),
                root,
            );
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            const workspace = join(
                root,
                "prepare",
                "workspaces",
                "positive-instrument",
            );
            assert.equal(
                readFileSync(join(workspace, "README.md"), "utf8").includes(
                    "TODO",
                ),
                true,
            );
            assert.equal(
                existsSync(join(workspace, "src", "checkout.ts")),
                true,
            );
            assert.equal(
                existsSync(join(workspace, "AGENTS.md")),
                false,
                "the shipped fixture must not constrain arm instructions",
            );
        } finally {
            process.chdir(previous);
            rmSync(elsewhere, { recursive: true, force: true });
        }
    });

    it("plans the repetitions campaign with a user route and no provider traffic", async () => {
        const dir = mkdtempSync(join(tmpdir(), "otc-route-"));
        try {
            const loaded = loadCampaignBundle(repetitions);
            assert.equal(loaded.ok, true);
            if (!loaded.ok) return;
            const document = JSON.parse(
                readFileSync(repetitions, "utf8"),
            ) as Record<string, unknown> & {
                runtime: { provider: Record<string, unknown> };
            };
            document.runtime.provider = {
                route: "user-route",
                model: "example-provider/example-model",
                overlay: {
                    providers: {
                        "example-provider": {
                            settings: { baseURL: "http://127.0.0.1:1/v1" },
                        },
                    },
                },
            };
            const campaignPath = join(dir, "campaign.json");
            const suitePath = join(dir, "suite.json");
            const shipped = readFileSync(
                join(repoRoot, "examples", "skills", "suite.json"),
                "utf8",
            );
            writeFileSync(
                campaignPath,
                `${JSON.stringify(document, null, 2)}\n`,
            );
            writeFileSync(suitePath, shipped);
            for (const path of ["skills", "fixtures"]) {
                cpSync(
                    join(repoRoot, "examples", "skills", path),
                    join(dir, path),
                    { recursive: true },
                );
            }
            const substituted = JSON.parse(
                readFileSync(campaignPath, "utf8"),
            ) as {
                suite: { path: string };
                subjects: Array<{ skills: Array<{ path: string }> }>;
            };
            substituted.suite.path = "suite.json";

            writeFileSync(
                campaignPath,
                `${JSON.stringify(substituted, null, 2)}\n`,
            );

            const validated = loadCampaignBundle(campaignPath);
            assert.deepEqual(
                validated.ok ? [] : validated.problems,
                [],
                "the documented provider substitution must still validate",
            );
            const root = join(dir, "root");
            const prepared = prepareCampaign(campaignPath, root);
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            const frozen = await freezeCampaign(root, fakeImage as never);
            assert.equal(
                frozen.ok,
                true,
                frozen.ok ? "" : frozen.problems.join("; "),
            );
            const dry = await runCampaign(
                root,
                { dryRun: true },
                {
                    runContainer: async () => {
                        throw new Error("dry run started a container");
                    },
                },
            );
            assert.equal(dry.ok, true, dry.problems.join("; "));
            assert.equal(dry.ran.length, 9);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
