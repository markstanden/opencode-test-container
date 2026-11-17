/**
 * Coverage ownership check.
 *
 * Two populations have different histories:
 * - the migrated docs analysis modules were previously gated at 95/90/95 in
 *   the docs repository, so their OTC equivalents must keep those floors
 *   (the non-measured legacy CLI entry `replay.ts` is reported separately);
 * - the new OTC runtime (contracts, campaign lifecycle, adapters, evaluators,
 *   CLI) is a new population with an explicit initial ratchet.
 *
 * The command writes the overall lcov Sonar consumes and fails loudly if
 * either population drops below its declared floor.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const LCOV = join(ROOT, "coverage", "lcov.info");

/** The two declared populations and their floors. */
const POPULATIONS = [
    {
        name: "all OTC runtime",
        include: (_file) => true,
        floors: { line: 75, branch: 55, function: 80 },
    },
    {
        name: "new OTC lifecycle, adapters and evaluators",
        include: (file) =>
            !file.includes("/analysis/") &&
            !file.includes("/harness/") &&
            !file.includes("/legacy/"),
        floors: { line: 82, branch: 66, function: 84 },
    },
    {
        name: "migrated docs analysis (previously gated)",
        include: (file) =>
            file.includes("src/evaluators/docs/analysis/") &&
            !file.endsWith("replay.ts"),
        floors: { line: 95, branch: 90, function: 95 },
    },
];

/** Run the suite with coverage over the whole source tree. */
function runCoverage() {
    rmSync(join(ROOT, "coverage"), { recursive: true, force: true });
    mkdirSync(join(ROOT, "coverage"), { recursive: true });
    const result = spawnSync(
        process.execPath,
        [
            "--test",
            "--experimental-test-coverage",
            "--test-coverage-include=src/**/*.ts",
            "--test-coverage-exclude=**/*.test.ts",
            "--test-reporter=lcov",
            `--test-reporter-destination=${LCOV}`,
            "tests/**/*.test.ts",
        ],
        { cwd: ROOT, encoding: "utf8", stdio: "inherit" },
    );
    if (result.status !== 0) {
        throw new Error(`coverage tests failed with ${String(result.status)}`);
    }
}

/** Counters from one lcov block. */
function countsOf(block) {
    const counts = { line: [0, 0], branch: [0, 0], function: [0, 0] };
    for (const line of block.split("\n")) {
        const [key, value] = line.split(":");
        if (value === undefined) continue;
        if (key === "LF") counts.line[1] = Number(value);
        if (key === "LH") counts.line[0] = Number(value);
        if (key === "BRF") counts.branch[1] = Number(value);
        if (key === "BRH") counts.branch[0] = Number(value);
        if (key === "FNF") counts.function[1] = Number(value);
        if (key === "FNH") counts.function[0] = Number(value);
    }
    return counts;
}

/** Parse lcov into per-file counters. */
function parseLcov(text) {
    return text.split("end_of_record").flatMap((block) => {
        const file = /^SF:(.+)$/m.exec(block)?.[1];
        return file === undefined ? [] : [{ file, counts: countsOf(block) }];
    });
}

/** Sum counters for one population. */
function totals(files, include) {
    const total = { line: [0, 0], branch: [0, 0], function: [0, 0] };
    for (const entry of files.filter((one) => include(one.file))) {
        for (const key of ["line", "branch", "function"]) {
            total[key][0] += entry.counts[key][0];
            total[key][1] += entry.counts[key][1];
        }
    }
    return total;
}

/** Percentage, or 100 for a population with no measured items. */
function percent([hit, found]) {
    return found === 0 ? 100 : (hit / found) * 100;
}

/** Every TypeScript source file, including files no test ever imports. */
function sourceFiles() {
    const root = join(ROOT, "src");
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory).sort()) {
            const path = join(directory, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry.endsWith(".ts")) {
                found.push(relative(root, path).split(sep).join("/"));
            }
        }
    };
    walk(root);
    return found.sort();
}

/**
 * Source files deliberately outside the measured population, with the reason.
 * Type-only modules and re-export facades are erased or measured through the
 * modules they name; every other source file must be imported by the suite.
 */
const SOURCE_EXCLUSIONS = new Map([
    ["index.ts", "public re-export facade; each module is measured directly"],
    ["contracts/types.ts", "type-only module, erased at runtime"],
    [
        "evaluators/docs/index.ts",
        "re-export facade measured through its named modules",
    ],
]);

runCoverage();
const files = parseLcov(readFileSync(LCOV, "utf8"));
const measuredFiles = new Set(
    files.map((entry) => relative(join(ROOT, "src"), entry.file).split(sep).join("/")),
);
const unmeasured = sourceFiles()
    .filter((file) => !SOURCE_EXCLUSIONS.has(file))
    .filter((file) => !measuredFiles.has(file));
let failed = unmeasured.length > 0;
if (failed) {
    console.error(
        `coverage: source files were never imported by the suite: ${unmeasured.join(", ")}`,
    );
    console.error(
        "coverage: add a test that imports them, or document a legitimate exclusion",
    );
}
for (const population of POPULATIONS) {
    const sum = totals(files, population.include);
    const measured = {
        line: percent(sum.line),
        branch: percent(sum.branch),
        function: percent(sum.function),
    };
    const line = `${population.name}: line ${measured.line.toFixed(1)}, branch ${measured.branch.toFixed(1)}, function ${measured.function.toFixed(1)} (floors ${population.floors.line}/${population.floors.branch}/${population.floors.function})`;
    console.log(line);
    for (const key of ["line", "branch", "function"]) {
        if (measured[key] + 1e-9 < population.floors[key]) {
            console.error(`coverage: ${population.name} ${key} below floor`);
            failed = true;
        }
    }
}
if (failed) process.exit(1);
