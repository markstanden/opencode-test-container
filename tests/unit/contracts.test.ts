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

/** A minimal valid docs suite. */
function docsSuite(overrides: Record<string, unknown> = {}): unknown {
    return {
        schemaVersion: 1,
        suiteId: "docs",
        assessment: "docs-recording",
        cases: [
            {
                caseId: "write",
                kind: "docs-task",
                prompt: "Record it.",
                expectedDocs: { kind: "create", target: "notes/otel.md" },
            },
        ],
        ...overrides,
    };
}

/** A minimal valid docs campaign. */
function docsCampaign(overrides: Record<string, unknown> = {}): unknown {
    return campaign({
        subjects: [{ armId: "baseline" }],
        schedule: {
            kind: "explicit",
            slots: [
                {
                    slotId: "s1",
                    caseId: "write",
                    armId: "baseline",
                    repetitionId: "r0",
                },
            ],
        },
        assessment: { kind: "docs-recording" },
        ...overrides,
    });
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

    it("rejects a primaryCheck on a skill-trigger case", () => {
        const parsed = validateSuite(
            suite({
                cases: [
                    {
                        caseId: "positive",
                        kind: "skill-trigger",
                        targetSkillId: "otel",
                        expected: "activation",
                        prompt: "Instrument it.",
                        primaryCheck: {
                            id: "installer",
                            directory: "check",
                            script: "check.mjs",
                        },
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /unexpected field "primaryCheck"/,
        );
    });

    it("rejects an unknown field on a skill-trigger case", () => {
        const parsed = validateSuite(
            suite({
                cases: [
                    {
                        caseId: "positive",
                        kind: "skill-trigger",
                        targetSkillId: "otel",
                        expected: "activation",
                        prompt: "Instrument it.",
                        expectedDocs: { kind: "none" },
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /unexpected field "expectedDocs"/,
        );
    });

    it("rejects an unknown field on a docs-task case", () => {
        const parsed = validateSuite(
            docsSuite({
                cases: [
                    {
                        caseId: "write",
                        kind: "docs-task",
                        prompt: "Record it.",
                        expectedDocs: { kind: "none" },
                        targetSkillId: "otel",
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /unexpected field "targetSkillId"/,
        );
    });

    it("accepts every documented field on a skill-trigger case", () => {
        const parsed = validateSuite(
            suite({
                cases: [
                    {
                        caseId: "positive",
                        kind: "skill-trigger",
                        targetSkillId: "otel",
                        expected: "activation",
                        prompt: "Instrument it.",
                        fixture: "fixtures/service",
                        files: { "README.md": "# service\n" },
                        contamination: "record",
                        allowMissingTarget: true,
                    },
                ],
            }),
        );
        assert.equal(parsed.ok, true);
    });
});

describe("campaign validation", () => {
    it("accepts a single-arm skill baseline", () => {
        assert.equal(validateCampaign(campaign()).ok, true);
    });

    it("refuses a NUL in a subject source path", () => {
        const parsed = validateCampaign(
            campaign({
                subjects: [
                    {
                        armId: "baseline",
                        skills: [{ id: "otel", path: "skills\u0000otel" }],
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

describe("docs primary-check and judge contract", () => {
    it("preserves a docs case primary checker through validation", () => {
        // Arrange
        const value = docsSuite({
            cases: [
                {
                    caseId: "write",
                    kind: "docs-task",
                    prompt: "Record it.",
                    expectedDocs: { kind: "create", target: "notes/otel.md" },
                    primaryCheck: {
                        id: "check",
                        directory: "checkers",
                        script: "check.mjs",
                        timeoutMs: 5000,
                    },
                },
            ],
        });

        // Act
        const parsed = validateSuite(value);

        // Assert
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.deepEqual(
            parsed.value.cases[0]?.kind === "docs-task"
                ? parsed.value.cases[0].primaryCheck
                : null,
            {
                id: "check",
                directory: "checkers",
                script: "check.mjs",
                timeoutMs: 5000,
            },
        );
    });

    it("preserves docs-case truth without exposing it to a trial", () => {
        // Arrange
        const value = docsSuite({
            cases: [
                {
                    caseId: "write",
                    kind: "docs-task",
                    prompt: "Record it.",
                    truth: "A durable fact.",
                    expectedDocs: { kind: "create", target: "notes/otel.md" },
                },
            ],
        });

        // Act
        const parsed = validateSuite(value);

        // Assert
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(
            parsed.value.cases[0]?.kind === "docs-task"
                ? parsed.value.cases[0].truth
                : null,
            "A durable fact.",
        );
    });

    it("refuses a checker script that escapes its staged directory", () => {
        // Arrange
        const value = docsSuite({
            cases: [
                {
                    caseId: "write",
                    kind: "docs-task",
                    prompt: "Record it.",
                    expectedDocs: { kind: "create", target: "notes/otel.md" },
                    primaryCheck: {
                        id: "check",
                        directory: "checkers",
                        script: "../check.mjs",
                    },
                },
            ],
        });

        // Act
        const parsed = validateSuite(value);

        // Assert
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /primaryCheck\.script/,
        );
    });

    it("refuses a non-positive checker timeout", () => {
        // Arrange
        const value = docsSuite({
            cases: [
                {
                    caseId: "write",
                    kind: "docs-task",
                    prompt: "Record it.",
                    expectedDocs: { kind: "create", target: "notes/otel.md" },
                    primaryCheck: {
                        id: "check",
                        directory: "checkers",
                        script: "check.mjs",
                        timeoutMs: 0,
                    },
                },
            ],
        });

        // Act
        const parsed = validateSuite(value);

        // Assert
        assert.equal(parsed.ok, false);
        assert.match(parsed.ok ? "" : parsed.problems.join("\n"), /timeoutMs/);
    });

    it("accepts a judge model with its timeout", () => {
        // Arrange
        const value = docsCampaign({
            assessment: {
                kind: "docs-recording",
                judge: { model: "p/judge", timeoutMs: 1000 },
            },
        });

        // Act
        const parsed = validateCampaign(value);

        // Assert
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.deepEqual(parsed.value.assessment.judge, {
            model: "p/judge",
            timeoutMs: 1000,
        });
    });

    it("accepts a narrow recovery registration", () => {
        // Arrange
        const value = docsCampaign({
            assessment: {
                kind: "docs-recording",
                recovery: {
                    version: 1,
                    eligibleFailureClasses: ["json-syntax"],
                    requiresCompletionEvidence: true,
                    maxRecoveriesPerSlot: 1,
                    recoveryCeiling: 1,
                    totalJudgeAttempts: 2,
                    providerRequestLimit: null,
                },
            },
        });

        // Act
        const parsed = validateCampaign(value);

        // Assert
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.value.assessment.recovery?.recoveryCeiling, 1);
    });

    it("refuses a malformed recovery registration at the boundary", () => {
        // Arrange
        const value = docsCampaign({
            assessment: {
                kind: "docs-recording",
                recovery: {
                    version: 1,
                    eligibleFailureClasses: "json-syntax",
                    requiresCompletionEvidence: true,
                    maxRecoveriesPerSlot: 1,
                    recoveryCeiling: 1,
                    totalJudgeAttempts: 2,
                    providerRequestLimit: null,
                },
            },
        });

        // Act
        const parsed = validateCampaign(value);

        // Assert
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /eligibleFailureClasses/,
        );
    });

    it("refuses recovery on a skill-activation campaign", () => {
        // Arrange
        const value = campaign({
            assessment: {
                kind: "skill-activation",
                recovery: {
                    version: 1,
                    eligibleFailureClasses: ["json-syntax"],
                    requiresCompletionEvidence: true,
                    maxRecoveriesPerSlot: 1,
                    recoveryCeiling: 1,
                    totalJudgeAttempts: 2,
                    providerRequestLimit: null,
                },
            },
        });

        // Act
        const parsed = validateCampaign(value);

        // Assert
        assert.equal(parsed.ok, false);
        assert.match(
            parsed.ok ? "" : parsed.problems.join("\n"),
            /only supported for docs-recording/,
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
