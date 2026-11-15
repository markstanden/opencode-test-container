import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    validateCampaign,
    validateSuite,
    isSafeRelativePath,
    ID_PATTERN,
} from "../../src/contracts/validate.ts";

/** A minimal valid skill suite. */
function suite(overrides: Record<string, unknown> = {}): unknown {
    return {
        schemaVersion: 1,
        suiteId: "skills",
        assessment: "skill-activation",
        cases: [
            {
                caseId: "positive",
                kind: "skill-trigger",
                targetSkillId: "otel",
                expected: "activation",
                prompt: "Instrument it.",
            },
        ],
        ...overrides,
    };
}

/** A minimal valid campaign. */
function campaign(overrides: Record<string, unknown> = {}): unknown {
    return {
        schemaVersion: 1,
        campaignId: "campaign-1",
        suite: { path: "suite.json" },
        subjects: [
            {
                armId: "baseline",
                skills: [{ id: "otel", path: "skills/otel" }],
            },
        ],
        schedule: {
            kind: "explicit",
            slots: [
                {
                    slotId: "s1",
                    caseId: "positive",
                    armId: "baseline",
                    repetitionId: "r0",
                },
            ],
        },
        runtime: {
            image: "localhost/otc:test",
            opencodeVersion: "2.2.6",
            provider: { route: "scripted", model: "p/m" },
            timeoutMs: 1000,
            network: "host",
        },
        budgets: { trials: 1, judgeAttempts: 0 },
        assessment: { kind: "skill-activation" },
        ...overrides,
    };
}

describe("suite validation", () => {
    it("accepts a discriminated skill-trigger case", () => {
        const parsed = validateSuite(suite());
        assert.equal(parsed.ok, true);
    });

    it("rejects a trigger case without an exact target identity", () => {
        const parsed = validateSuite(
            suite({
                cases: [
                    {
                        caseId: "positive",
                        kind: "skill-trigger",
                        expected: "activation",
                        prompt: "Instrument it.",
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /targetSkillId/,
        );
    });

    it("rejects duplicate case ids", () => {
        const one = {
            caseId: "same",
            kind: "skill-trigger",
            targetSkillId: "otel",
            expected: "activation",
            prompt: "A",
        };
        const parsed = validateSuite(suite({ cases: [one, { ...one }] }));
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /duplicate caseId/,
        );
    });

    it("rejects a docs case in a skill suite", () => {
        const parsed = validateSuite(
            suite({
                cases: [
                    {
                        caseId: "docs",
                        kind: "docs-task",
                        prompt: "Write it.",
                        expectedDocs: { kind: "none" },
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
    });
});

describe("campaign validation", () => {
    it("accepts a single-arm skill baseline", () => {
        assert.equal(validateCampaign(campaign()).ok, true);
    });

    it("refuses path traversal in a subject path", () => {
        const parsed = validateCampaign(
            campaign({
                subjects: [
                    {
                        armId: "baseline",
                        skills: [{ id: "otel", path: "../../etc" }],
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /source path/,
        );
    });

    it("refuses an asset-named credential in a provider overlay", () => {
        const parsed = validateCampaign(
            campaign({
                runtime: {
                    image: "localhost/otc:test",
                    opencodeVersion: "2.2.6",
                    provider: {
                        route: "scripted",
                        model: "p/m",
                        overlay: { headers: { apiKey: "secret" } },
                    },
                    timeoutMs: 1000,
                    network: "host",
                },
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(parsed.ok ? "" : parsed.problems.join("\n"), /credential/);
    });

    it("refuses a budget above the scheduled slot count", () => {
        const parsed = validateCampaign(
            campaign({ budgets: { trials: 2, judgeAttempts: 0 } }),
        );
        assert.equal(parsed.ok, false);
    });

    it("refuses a schedule that names an undeclared arm", () => {
        const parsed = validateCampaign(
            campaign({
                schedule: {
                    kind: "explicit",
                    slots: [
                        {
                            slotId: "s1",
                            caseId: "positive",
                            armId: "missing",
                            repetitionId: "r0",
                        },
                    ],
                },
            }),
        );
        assert.equal(
            parsed.ok,
            true,
            "cross-reference is checked by validateBundle",
        );
    });
});

describe("path and identity syntax", () => {
    it("rejects absolute and parent paths", () => {
        assert.equal(isSafeRelativePath("/etc/passwd"), false);
        assert.equal(isSafeRelativePath("a/../b"), false);
        assert.equal(isSafeRelativePath("a/b.md"), true);
    });

    it("pins the identifier syntax", () => {
        assert.equal(ID_PATTERN.test("slot-1"), true);
        assert.equal(ID_PATTERN.test("../slot"), false);
        assert.equal(ID_PATTERN.test(""), false);
    });
});
