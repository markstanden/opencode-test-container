import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { sha256Bytes } from "./canonical.ts";
import type {
    Arm,
    AssessmentKind,
    Campaign,
    CampaignBundle,
    CaseBase,
    DocsTaskCase,
    ExpectedDocs,
    InstructionSubject,
    PluginSubject,
    ProviderRoute,
    RuntimeSpec,
    SkillSubject,
    SkillTriggerCase,
    Slot,
    Suite,
    SuiteCase,
} from "./types.ts";

/** A successful parse, or the actionable problems that prevent one. */
export type Parsed<T> =
    { ok: true; value: T } | { ok: false; problems: string[] };

/** The identifier syntax every new OTC identity uses. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Keys whose values must never enter a committed campaign document. */
const SECRET_KEY = /key|token|secret|password|credential/i;

/** Whether a value is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a string is a usable identifier. */
export function isId(value: unknown): value is string {
    return typeof value === "string" && ID_PATTERN.test(value);
}

/** Whether a string is a non-blank value. */
export function isText(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether a path is relative, non-empty and free of parent traversal. It is
 * syntax validation only; containment of an existing file is checked when it
 * is resolved.
 * @param value The candidate path.
 * @returns True for a safe relative path.
 */
export function isSafeRelativePath(value: unknown): value is string {
    if (!isText(value) || isAbsolute(value) || value.includes("\0")) {
        return false;
    }
    const normalised = value.replaceAll("\\", "/");
    return !normalised.split("/").some((part) => part === "..");
}

/**
 * Whether a subject source path is acceptable: an absolute path, or a safe
 * relative path. Subject payloads are staged before dispatch, so a source
 * outside the campaign document is allowed; containment is enforced on the
 * staged tree, not on the developer's layout.
 * @param value The candidate source path.
 * @returns True for an absolute path or a safe relative path.
 */
export function isSourcePath(value: unknown): value is string {
    return isText(value) && (isAbsolute(value) || isSafeRelativePath(value));
}

/** Read JSON from a path, preserving parse failure as a problem. */
export function readJson(
    path: string,
): { ok: true; value: unknown } | { ok: false; problem: string } {
    try {
        return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
    } catch (error) {
        return {
            ok: false,
            problem: `${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** Collect a string member, or record that it is missing. */
function requiredText(
    record: Record<string, unknown>,
    field: string,
    where: string,
    problems: string[],
): string | undefined {
    const value = record[field];
    if (!isText(value)) {
        problems.push(`${where}.${field} must be a non-blank string`);
        return undefined;
    }
    return value;
}

/** Collect one identifier member. */
function requiredId(
    record: Record<string, unknown>,
    field: string,
    where: string,
    problems: string[],
): string | undefined {
    const value = record[field];
    if (!isId(value)) {
        problems.push(
            `${where}.${field} must match ${ID_PATTERN.source} (got ${JSON.stringify(value)})`,
        );
        return undefined;
    }
    return value;
}

/** Reject a nested object that looks like a credential. */
function secretProblems(value: unknown, where: string): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) =>
            secretProblems(entry, `${where}[${index}]`),
        );
    }
    if (!isRecord(value)) return [];
    return Object.entries(value).flatMap(([key, entry]) =>
        SECRET_KEY.test(key)
            ? [`${where}.${key} names a credential; inject it through env`]
            : secretProblems(entry, `${where}.${key}`),
    );
}

/** Validate a case's inline file map. */
function filesProblems(value: unknown, where: string): string[] {
    if (value === undefined) return [];
    if (!isRecord(value)) return [`${where}.files must be an object`];
    return Object.entries(value).flatMap(([path, contents]) => [
        ...(isSafeRelativePath(path)
            ? []
            : [`${where}.files has an unsafe path ${path}`]),
        ...(typeof contents === "string"
            ? []
            : [`${where}.files.${path} must be a string`]),
    ]);
}

/** The string-valued inline file map. */
function filesOf(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    return Object.fromEntries(
        Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
    );
}

/** Validate the shared case fields. */
function caseBase(
    record: Record<string, unknown>,
    where: string,
    problems: string[],
): CaseBase | null {
    const caseId = requiredId(record, "caseId", where, problems);
    const prompt = requiredText(record, "prompt", where, problems);
    if (caseId === undefined || prompt === undefined) return null;
    for (const field of ["fixture", "lakeRoot"] as const) {
        if (record[field] !== undefined && !isSafeRelativePath(record[field])) {
            problems.push(`${where}.${field} must be a safe relative path`);
        }
    }
    problems.push(...filesProblems(record.files, where));
    const base: CaseBase = { caseId, prompt };
    if (typeof record.fixture === "string") base.fixture = record.fixture;
    const files = filesOf(record.files);
    if (files !== undefined) base.files = files;
    return base;
}

/** Validate the optional skill-case policy flags. */
function skillOptions(
    record: Record<string, unknown>,
    where: string,
    problems: string[],
): { contamination?: "fail" | "record"; allowMissingTarget?: true } | null {
    const contamination = record.contamination;
    if (
        contamination !== undefined &&
        contamination !== "fail" &&
        contamination !== "record"
    ) {
        problems.push(`${where}.contamination must be "fail" or "record"`);
        return null;
    }
    if (
        record.allowMissingTarget !== undefined &&
        typeof record.allowMissingTarget !== "boolean"
    ) {
        problems.push(`${where}.allowMissingTarget must be a boolean`);
        return null;
    }
    return {
        ...(contamination === undefined ? {} : { contamination }),
        ...(record.allowMissingTarget === true
            ? { allowMissingTarget: true as const }
            : {}),
    };
}

/** Validate one skill-trigger case. */
function skillCase(
    record: Record<string, unknown>,
    where: string,
    problems: string[],
): SkillTriggerCase | null {
    const base = caseBase(record, where, problems);
    const targetSkillId = requiredId(record, "targetSkillId", where, problems);
    const expected = record.expected;
    if (expected !== "activation" && expected !== "no-activation") {
        problems.push(
            `${where}.expected must be "activation" or "no-activation"`,
        );
    }
    const options = skillOptions(record, where, problems);
    if (
        base === null ||
        targetSkillId === undefined ||
        options === null ||
        (expected !== "activation" && expected !== "no-activation")
    ) {
        return null;
    }
    return {
        ...base,
        kind: "skill-trigger",
        targetSkillId,
        expected,
        ...options,
    };
}

/** Validate the string-list fields of an expected-docs block. */
function expectedListProblems(
    value: Record<string, unknown>,
    where: string,
): string[] {
    return (["retains", "omits"] as const).flatMap((field) =>
        value[field] !== undefined &&
        (!Array.isArray(value[field]) || !value[field].every(isText))
            ? [`${where}.expectedDocs.${field} must be strings`]
            : [],
    );
}

/** Validate the shape of an expected-docs block. */
function expectedShapeProblems(
    value: Record<string, unknown>,
    where: string,
): string[] {
    const problems: string[] = [];
    if (value.kind !== "none" && !isSafeRelativePath(value.target)) {
        problems.push(
            `${where}.expectedDocs.target must be a safe relative lake path`,
        );
    }
    problems.push(...expectedListProblems(value, where));
    if (value.link !== undefined && !isSafeRelativePath(value.link)) {
        problems.push(
            `${where}.expectedDocs.link must be a safe relative path`,
        );
    }
    return problems;
}

/** The typed expected-docs value. */
function expectedValue(
    value: Record<string, unknown>,
    kind: ExpectedDocs["kind"],
): ExpectedDocs {
    return {
        kind,
        ...(typeof value.target === "string" ? { target: value.target } : {}),
        ...(typeof value.link === "string" ? { link: value.link } : {}),
        ...(Array.isArray(value.retains)
            ? { retains: value.retains.filter(isText) }
            : {}),
        ...(Array.isArray(value.omits)
            ? { omits: value.omits.filter(isText) }
            : {}),
    };
}

/** Validate an expected-docs block. */
function expectedDocsOf(
    value: unknown,
    where: string,
    problems: string[],
): ExpectedDocs | undefined {
    if (!isRecord(value)) {
        problems.push(`${where}.expectedDocs must be an object`);
        return undefined;
    }
    const kind = value.kind;
    if (kind !== "create" && kind !== "replace" && kind !== "none") {
        problems.push(
            `${where}.expectedDocs.kind must be create, replace or none`,
        );
        return undefined;
    }
    problems.push(...expectedShapeProblems(value, where));
    return expectedValue(value, kind);
}

/** Validate a docs criterion block. */
function criterionOf(
    value: unknown,
    where: string,
    problems: string[],
): DocsTaskCase["criterion"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        problems.push(`${where}.criterion must be an object`);
        return undefined;
    }
    const minVerifiedCalls = value.minVerifiedCalls;
    if (
        typeof minVerifiedCalls !== "number" ||
        !Number.isInteger(minVerifiedCalls) ||
        minVerifiedCalls < 0
    ) {
        problems.push(
            `${where}.criterion.minVerifiedCalls must be a non-negative integer`,
        );
        return undefined;
    }
    if (value.verbs !== undefined && !Array.isArray(value.verbs)) {
        problems.push(`${where}.criterion.verbs must be an array`);
        return undefined;
    }
    return {
        minVerifiedCalls,
        ...(Array.isArray(value.verbs)
            ? { verbs: value.verbs.filter(isText) }
            : {}),
    };
}

/** Validate a docs guardrails block. */
function guardrailsOf(
    value: unknown,
    where: string,
    problems: string[],
): DocsTaskCase["guardrails"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        problems.push(`${where}.guardrails must be an object`);
        return undefined;
    }
    for (const field of ["unchanged", "absent"] as const) {
        if (
            value[field] !== undefined &&
            (!Array.isArray(value[field]) ||
                !value[field].every(isSafeRelativePath))
        ) {
            problems.push(
                `${where}.guardrails.${field} must be safe relative paths`,
            );
        }
    }
    return {
        ...(Array.isArray(value.unchanged)
            ? { unchanged: value.unchanged.filter(isText) }
            : {}),
        ...(Array.isArray(value.absent)
            ? { absent: value.absent.filter(isText) }
            : {}),
    };
}

/** Validate one docs-task case without exposing its truth to a trial. */
function docsCase(
    record: Record<string, unknown>,
    where: string,
    problems: string[],
): DocsTaskCase | null {
    const base = caseBase(record, where, problems);
    const expectedDocs = expectedDocsOf(record.expectedDocs, where, problems);
    const criterion = criterionOf(record.criterion, where, problems);
    const guardrails = guardrailsOf(record.guardrails, where, problems);
    if (base === null || expectedDocs === undefined) return null;
    return {
        ...base,
        kind: "docs-task",
        expectedDocs,
        ...(criterion === undefined ? {} : { criterion }),
        ...(guardrails === undefined ? {} : { guardrails }),
        ...(typeof record.lakeRoot === "string"
            ? { lakeRoot: record.lakeRoot }
            : {}),
    };
}

/** Parse one discriminated suite case. */
function suiteCaseOf(
    value: unknown,
    where: string,
    problems: string[],
): SuiteCase | null {
    if (!isRecord(value)) {
        problems.push(`${where} must be an object`);
        return null;
    }
    if (value.kind === "skill-trigger")
        return skillCase(value, where, problems);
    if (value.kind === "docs-task") return docsCase(value, where, problems);
    problems.push(`${where}.kind must be "skill-trigger" or "docs-task"`);
    return null;
}

/** Check every case matches the suite's assessment kind. */
function suiteKindProblems(
    assessment: string,
    cases: readonly SuiteCase[],
): string[] {
    const expected =
        assessment === "skill-activation" ? "skill-trigger" : "docs-task";
    if (cases.every((one) => one.kind === expected)) return [];
    return [
        assessment === "skill-activation"
            ? "a skill-activation suite may contain only skill-trigger cases"
            : "a docs-recording suite may contain only docs-task cases",
    ];
}

/** Collect unique suite cases, reporting duplicates. */
function collectSuiteCases(value: unknown, problems: string[]): SuiteCase[] {
    if (!Array.isArray(value) || value.length === 0) {
        problems.push("suite.cases must be a non-empty array");
        return [];
    }
    const seen = new Set<string>();
    return value.flatMap((entry, index) => {
        const parsed = suiteCaseOf(entry, `suite.cases[${index}]`, problems);
        if (parsed === null) return [];
        if (seen.has(parsed.caseId)) {
            problems.push(`duplicate caseId ${parsed.caseId}`);
            return [];
        }
        seen.add(parsed.caseId);
        return [parsed];
    });
}

/**
 * Validate a suite document.
 * @param value The parsed JSON value.
 * @returns The typed suite or every problem found.
 */
export function validateSuite(value: unknown): Parsed<Suite> {
    if (!isRecord(value)) {
        return { ok: false, problems: ["suite must be an object"] };
    }
    const problems: string[] = [];
    if (value.schemaVersion !== 1) {
        problems.push("suite.schemaVersion must be 1");
    }
    const suiteId = requiredId(value, "suiteId", "suite", problems);
    const assessment = value.assessment;
    const assessmentValid =
        assessment === "skill-activation" || assessment === "docs-recording";
    if (!assessmentValid) {
        problems.push(
            'suite.assessment must be "skill-activation" or "docs-recording"',
        );
    }
    const cases = collectSuiteCases(value.cases, problems);
    if (assessmentValid) {
        problems.push(...suiteKindProblems(assessment, cases));
    }
    if (problems.length > 0 || suiteId === undefined || !assessmentValid) {
        return { ok: false, problems };
    }
    const suite: Suite = { schemaVersion: 1, suiteId, assessment, cases };
    if (typeof value.description === "string") {
        suite.description = value.description;
    }
    return { ok: true, value: suite };
}

/** Parse one arm's skill declarations. */
function parseSkills(
    value: unknown,
    where: string,
    base: string,
    problems: string[],
): SkillSubject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        problems.push(`${where}.skills must be an array`);
        return [];
    }
    const seen = new Set<string>();
    return value.flatMap((entry, index) => {
        const at = `${where}.skills[${index}]`;
        if (!isRecord(entry)) {
            problems.push(`${at} must be an object`);
            return [];
        }
        const id = requiredId(entry, "id", at, problems);
        if (!isSourcePath(entry.path)) {
            problems.push(`${at}.path must be a local source path`);
            return [];
        }
        if (id === undefined) return [];
        if (seen.has(id)) {
            problems.push(`${at}.id duplicates ${id}`);
            return [];
        }
        seen.add(id);
        return [{ id, path: resolve(base, entry.path) }];
    });
}

/** Parse one arm's plugin declarations. */
function parsePlugins(
    value: unknown,
    where: string,
    base: string,
    problems: string[],
): PluginSubject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        problems.push(`${where}.plugins must be an array`);
        return [];
    }
    return value.flatMap((entry, index) => {
        const at = `${where}.plugins[${index}]`;
        if (!isRecord(entry)) {
            problems.push(`${at} must be an object`);
            return [];
        }
        const id = requiredId(entry, "id", at, problems);
        if (!isSourcePath(entry.path)) {
            problems.push(`${at}.path must be a local source path`);
            return [];
        }
        if (id === undefined) return [];
        if (
            entry.include !== undefined &&
            (!Array.isArray(entry.include) ||
                !entry.include.every(isSafeRelativePath))
        ) {
            problems.push(`${at}.include must be safe relative paths`);
        }
        if (entry.options !== undefined) {
            problems.push(...secretProblems(entry.options, `${at}.options`));
        }
        return [
            {
                id,
                path: resolve(base, entry.path),
                ...(Array.isArray(entry.include)
                    ? { include: entry.include.filter(isText) }
                    : {}),
                ...(entry.options === undefined
                    ? {}
                    : { options: entry.options }),
            },
        ];
    });
}

/** Parse one arm's instruction overlays. */
function parseInstructions(
    value: unknown,
    where: string,
    base: string,
    problems: string[],
): InstructionSubject[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        problems.push(`${where}.instructions must be an array`);
        return [];
    }
    return value.flatMap((entry, index) => {
        const at = `${where}.instructions[${index}]`;
        if (!isRecord(entry)) {
            problems.push(`${at} must be an object`);
            return [];
        }
        const id = requiredId(entry, "id", at, problems);
        if (!isSourcePath(entry.path)) {
            problems.push(`${at}.path must be a local source path`);
            return [];
        }
        const destination = entry.as ?? "AGENTS.md";
        if (!isSafeRelativePath(destination)) {
            problems.push(`${at}.as must be a safe relative path`);
            return [];
        }
        if (id === undefined) return [];
        return [
            {
                id,
                path: resolve(base, entry.path),
                as: destination,
            },
        ];
    });
}

/**
 * Parse and validate one arm's subject declarations.
 * @param value The parsed arm.
 * @param where The diagnostic path.
 * @param base Directory for relative sources.
 * @param problems The accumulating findings.
 * @returns The arm, or null when its identity is unusable.
 */
function parseArm(
    value: unknown,
    where: string,
    base: string,
    problems: string[],
): Arm | null {
    if (!isRecord(value)) {
        problems.push(`${where} must be an object`);
        return null;
    }
    const armId = requiredId(value, "armId", where, problems);
    if (armId === undefined) return null;
    const skills = parseSkills(value.skills, where, base, problems);
    const plugins = parsePlugins(value.plugins, where, base, problems);
    const instructions = parseInstructions(
        value.instructions,
        where,
        base,
        problems,
    );
    return {
        armId,
        ...(skills.length > 0 ? { skills } : {}),
        ...(plugins.length > 0 ? { plugins } : {}),
        ...(instructions.length > 0 ? { instructions } : {}),
    };
}

/** Validate a provider overlay and return it when usable. */
function overlayOf(
    value: unknown,
    problems: string[],
): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        problems.push("campaign.runtime.provider.overlay must be an object");
        return undefined;
    }
    problems.push(
        ...secretProblems(value, "campaign.runtime.provider.overlay"),
    );
    return value;
}

/** Parse the provider route. */
function parseProvider(
    value: unknown,
    problems: string[],
): ProviderRoute | null {
    if (!isRecord(value)) {
        problems.push("campaign.runtime.provider must be an object");
        return null;
    }
    const route = requiredText(
        value,
        "route",
        "campaign.runtime.provider",
        problems,
    );
    const model = requiredText(
        value,
        "model",
        "campaign.runtime.provider",
        problems,
    );
    if (model !== undefined && !model.includes("/")) {
        problems.push(
            'campaign.runtime.provider.model must be "provider/model"',
        );
    }
    const overlay = overlayOf(value.overlay, problems);
    if (route === undefined || model === undefined || !model.includes("/")) {
        return null;
    }
    return { route, model, ...(overlay === undefined ? {} : { overlay }) };
}

/** Validate the optional, non-secret runtime flags. */
function runtimeExtras(
    value: Record<string, unknown>,
    problems: string[],
): Partial<RuntimeSpec> {
    if (value.containerCli !== undefined && value.containerCli !== "podman") {
        problems.push('campaign.runtime.containerCli must be "podman"');
    }
    if (
        value.passthroughEnv !== undefined &&
        (!Array.isArray(value.passthroughEnv) ||
            !value.passthroughEnv.every(isText))
    ) {
        problems.push(
            "campaign.runtime.passthroughEnv must be environment names",
        );
        return {};
    }
    return {
        ...(typeof value.imageId === "string" && value.imageId !== ""
            ? { imageId: value.imageId }
            : {}),
        ...(value.containerCli === "podman" ? { containerCli: "podman" } : {}),
        ...(Array.isArray(value.passthroughEnv)
            ? { passthroughEnv: value.passthroughEnv }
            : {}),
    };
}

/** Validate the mandatory runtime scalars. */
function runtimeBase(
    value: Record<string, unknown>,
    problems: string[],
): Pick<
    RuntimeSpec,
    "image" | "opencodeVersion" | "timeoutMs" | "network"
> | null {
    const image = requiredText(value, "image", "campaign.runtime", problems);
    const opencodeVersion = requiredText(
        value,
        "opencodeVersion",
        "campaign.runtime",
        problems,
    );
    const timeoutMs = value.timeoutMs;
    const timeoutValid =
        typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs > 0;
    if (!timeoutValid) {
        problems.push("campaign.runtime.timeoutMs must be positive");
    }
    const networkValid = value.network === "host" || value.network === "none";
    if (!networkValid) {
        problems.push('campaign.runtime.network must be "host" or "none"');
    }
    if (
        image === undefined ||
        opencodeVersion === undefined ||
        !timeoutValid ||
        !networkValid
    ) {
        return null;
    }
    return {
        image,
        opencodeVersion,
        timeoutMs: timeoutMs as number,
        network: value.network as "host" | "none",
    };
}

/** Parse the runtime block. */
function parseRuntime(value: unknown, problems: string[]): RuntimeSpec | null {
    if (!isRecord(value)) {
        problems.push("campaign.runtime must be an object");
        return null;
    }
    const base = runtimeBase(value, problems);
    const provider = parseProvider(value.provider, problems);
    const extras = runtimeExtras(value, problems);
    if (base === null || provider === null) return null;
    return { ...base, provider, ...extras };
}

/** Parse the campaign's suite reference. */
function suiteRefOf(
    value: unknown,
    problems: string[],
): Campaign["suite"] | undefined {
    if (!isRecord(value) || !isSafeRelativePath(value.path)) {
        problems.push("campaign.suite.path must be a safe relative path");
        return undefined;
    }
    if (value.sha256 === undefined) return { path: value.path };
    if (
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
        problems.push("campaign.suite.sha256 must be a SHA-256");
        return undefined;
    }
    return { path: value.path, sha256: value.sha256 };
}

/** Parse the campaign's arms. */
function subjectsOf(
    value: unknown,
    baseDir: string,
    problems: string[],
): Arm[] {
    if (!Array.isArray(value) || value.length === 0) {
        problems.push("campaign.subjects must be a non-empty array");
        return [];
    }
    const seen = new Set<string>();
    return value.flatMap((entry, index) => {
        const arm = parseArm(
            entry,
            `campaign.subjects[${index}]`,
            baseDir,
            problems,
        );
        if (arm === null) return [];
        if (seen.has(arm.armId)) {
            problems.push(`duplicate armId ${arm.armId}`);
            return [];
        }
        seen.add(arm.armId);
        return [arm];
    });
}

/** Parse one explicit slot. */
function slotOf(
    value: unknown,
    where: string,
    problems: string[],
): Slot | null {
    if (!isRecord(value)) {
        problems.push(`${where} must be an object`);
        return null;
    }
    const slotId = requiredId(value, "slotId", where, problems);
    const caseId = requiredId(value, "caseId", where, problems);
    const armId = requiredId(value, "armId", where, problems);
    const repetitionId = requiredId(value, "repetitionId", where, problems);
    if (
        slotId === undefined ||
        caseId === undefined ||
        armId === undefined ||
        repetitionId === undefined
    ) {
        return null;
    }
    return { slotId, caseId, armId, repetitionId };
}

/** Parse the explicit campaign schedule. */
function scheduleSlotsOf(value: unknown, problems: string[]): Slot[] {
    if (
        !isRecord(value) ||
        value.kind !== "explicit" ||
        !Array.isArray(value.slots) ||
        value.slots.length === 0
    ) {
        problems.push(
            'campaign.schedule must be {kind:"explicit", slots:[...]} with at least one slot',
        );
        return [];
    }
    const seen = new Set<string>();
    return value.slots.flatMap((entry, index) => {
        const slot = slotOf(
            entry,
            `campaign.schedule.slots[${index}]`,
            problems,
        );
        if (slot === null) return [];
        if (seen.has(slot.slotId)) {
            problems.push(`duplicate slotId ${slot.slotId}`);
            return [];
        }
        seen.add(slot.slotId);
        return [slot];
    });
}

/** Parse the campaign budgets. */
function budgetsOf(
    value: unknown,
    slots: number,
    problems: string[],
): Campaign["budgets"] | undefined {
    if (!isRecord(value)) {
        problems.push("campaign.budgets must be an object");
        return undefined;
    }
    const trials = value.trials;
    const judgeAttempts = value.judgeAttempts;
    const validCount = (candidate: unknown): candidate is number =>
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 0;
    if (!validCount(trials)) {
        problems.push("campaign.budgets.trials must be a non-negative integer");
    }
    if (!validCount(judgeAttempts)) {
        problems.push(
            "campaign.budgets.judgeAttempts must be a non-negative integer",
        );
    }
    if (validCount(trials) && slots > 0 && trials > slots) {
        problems.push(
            "campaign.budgets.trials may not exceed the scheduled slot count",
        );
    }
    if (!validCount(trials) || !validCount(judgeAttempts)) return undefined;
    return { trials, judgeAttempts };
}

/** Parse the campaign assessment block. */
function assessmentOf(
    value: unknown,
    problems: string[],
): Campaign["assessment"] | undefined {
    if (!isRecord(value)) {
        problems.push("campaign.assessment must be an object");
        return undefined;
    }
    if (value.kind !== "skill-activation" && value.kind !== "docs-recording") {
        problems.push(
            'campaign.assessment.kind must be "skill-activation" or "docs-recording"',
        );
        return undefined;
    }
    const assessment: Campaign["assessment"] = {
        kind: value.kind as AssessmentKind,
    };
    if (value.judge === undefined) return assessment;
    if (
        !isRecord(value.judge) ||
        !isText(value.judge.model) ||
        !value.judge.model.includes("/")
    ) {
        problems.push("campaign.assessment.judge.model must be provider/model");
        return undefined;
    }
    return { ...assessment, judge: { model: value.judge.model } };
}

/** Whether every mandatory campaign part parsed without problems. */
function campaignPartsComplete(parts: {
    problems: string[];
    campaignId: string | undefined;
    suiteRef: Campaign["suite"] | undefined;
    runtime: RuntimeSpec | null;
    budgets: Campaign["budgets"] | undefined;
    assessment: Campaign["assessment"] | undefined;
}): boolean {
    return (
        parts.problems.length === 0 &&
        parts.campaignId !== undefined &&
        parts.suiteRef !== undefined &&
        parts.runtime !== null &&
        parts.budgets !== undefined &&
        parts.assessment !== undefined
    );
}

/**
 * Validate a campaign document, before its suite is resolved.
 * @param value The parsed JSON value.
 * @param baseDir Directory for relative subject sources.
 * @returns The typed campaign or every problem found.
 */
export function validateCampaign(
    value: unknown,
    baseDir = ".",
): Parsed<Campaign> {
    if (!isRecord(value)) {
        return { ok: false, problems: ["campaign must be an object"] };
    }
    const problems: string[] = [];
    if (value.schemaVersion !== 1) {
        problems.push("campaign.schemaVersion must be 1");
    }
    const campaignId = requiredId(value, "campaignId", "campaign", problems);
    const suiteRef = suiteRefOf(value.suite, problems);
    const arms = subjectsOf(value.subjects, baseDir, problems);
    const slots = scheduleSlotsOf(value.schedule, problems);
    const runtime = parseRuntime(value.runtime, problems);
    const budgets = budgetsOf(value.budgets, slots.length, problems);
    const assessment = assessmentOf(value.assessment, problems);
    if (value.permissions !== undefined && !isRecord(value.permissions)) {
        problems.push("campaign.permissions must be an object");
    }
    if (
        !campaignPartsComplete({
            problems,
            campaignId,
            suiteRef,
            runtime,
            budgets,
            assessment,
        })
    ) {
        return { ok: false, problems };
    }
    return {
        ok: true,
        value: {
            schemaVersion: 1,
            campaignId: campaignId as string,
            suite: suiteRef as Campaign["suite"],
            subjects: arms,
            schedule: { kind: "explicit", slots },
            runtime: runtime as RuntimeSpec,
            budgets: budgets as Campaign["budgets"],
            assessment: assessment as Campaign["assessment"],
            ...(isRecord(value.permissions)
                ? { permissions: value.permissions }
                : {}),
            ...(value.stopOnFirstFailure === true
                ? { stopOnFirstFailure: true }
                : {}),
        },
    };
}

/** Check one slot's case/arm references and target-skill supply. */
function slotReferenceProblems(
    slot: Slot,
    cases: ReadonlyMap<string, SuiteCase>,
    arms: ReadonlyMap<string, Arm>,
): string[] {
    const testCase = cases.get(slot.caseId);
    const arm = arms.get(slot.armId);
    if (testCase === undefined) {
        return [`slot ${slot.slotId} names unknown caseId ${slot.caseId}`];
    }
    if (arm === undefined) {
        return [`slot ${slot.slotId} names unknown armId ${slot.armId}`];
    }
    if (
        testCase.kind === "skill-trigger" &&
        testCase.allowMissingTarget !== true &&
        !(arm.skills ?? []).some((skill) => skill.id === testCase.targetSkillId)
    ) {
        return [
            `slot ${slot.slotId}: arm ${arm.armId} does not supply skill ${testCase.targetSkillId}`,
        ];
    }
    return [];
}

/**
 * Validate a campaign together with its suite and cross-references.
 * @param campaignValue The parsed campaign document.
 * @param suiteValue The parsed suite document.
 * @param campaignPath Absolute campaign path, used for suite containment.
 * @param suitePath Absolute suite path.
 * @returns The bundle or every problem found.
 */
export function validateBundle(
    campaignValue: unknown,
    suiteValue: unknown,
    campaignPath: string,
    suitePath: string,
): Parsed<CampaignBundle> {
    const campaign = validateCampaign(campaignValue, dirname(campaignPath));
    const suite = validateSuite(suiteValue);
    if (!campaign.ok || !suite.ok) {
        return {
            ok: false,
            problems: [
                ...(campaign.ok ? [] : campaign.problems),
                ...(suite.ok ? [] : suite.problems),
            ],
        };
    }
    const problems: string[] = [];
    if (campaign.value.assessment.kind !== suite.value.assessment) {
        problems.push(
            `campaign.assessment.kind ${campaign.value.assessment.kind} does not match suite.assessment ${suite.value.assessment}`,
        );
    }
    const cases = new Map(suite.value.cases.map((one) => [one.caseId, one]));
    const arms = new Map(
        campaign.value.subjects.map((one) => [one.armId, one]),
    );
    for (const slot of campaign.value.schedule.slots) {
        problems.push(...slotReferenceProblems(slot, cases, arms));
    }
    if (problems.length > 0) return { ok: false, problems };
    return {
        ok: true,
        value: {
            campaign: campaign.value,
            suite: suite.value,
            campaignPath,
            suitePath,
            declaredSuiteSha256: campaign.value.suite.sha256 ?? null,
        },
    };
}

/**
 * Read and validate a campaign and its suite from disk.
 * @param campaignPath The campaign document path.
 * @returns The bundle, or actionable problems including unreadable files.
 */
export function loadCampaignBundle(
    campaignPath: string,
): Parsed<CampaignBundle> {
    const resolvedCampaign = resolve(campaignPath);
    const campaignJson = readJson(resolvedCampaign);
    if (!campaignJson.ok) {
        return { ok: false, problems: [campaignJson.problem] };
    }
    const parsed = validateCampaign(
        campaignJson.value,
        dirname(resolvedCampaign),
    );
    if (!parsed.ok) {
        return { ok: false, problems: parsed.problems };
    }
    const suitePath = resolve(
        dirname(resolvedCampaign),
        parsed.value.suite.path,
    );
    const suiteJson = readJson(suitePath);
    if (!suiteJson.ok) {
        return { ok: false, problems: [suiteJson.problem] };
    }
    if (parsed.value.suite.sha256 !== undefined) {
        const observed = sha256Bytes(readFileSync(suitePath));
        if (observed !== parsed.value.suite.sha256) {
            return {
                ok: false,
                problems: [
                    `suite sha256 mismatch: declared ${parsed.value.suite.sha256}, observed ${observed}`,
                ],
            };
        }
    }
    return validateBundle(
        campaignJson.value,
        suiteJson.value,
        resolvedCampaign,
        suitePath,
    );
}

/** Whether a value is one of the finite assessment kinds. */
export function isAssessmentKind(value: unknown): value is AssessmentKind {
    return value === "skill-activation" || value === "docs-recording";
}
