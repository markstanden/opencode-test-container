/**
 * A small static purity boundary check.
 *
 * It walks runtime imports (including re-exports and literal dynamic imports)
 * from an explicit list of modules and reports ambient time/random/env/cwd
 * access or external-effect APIs. Type-only edges are erased and ignored.
 * Limitations: it is a syntactic check, not a proof. It does not see computed
 * dynamic imports (which it rejects conservatively), indirect access through a
 * passed function value, or effects reached only through a dependency's own
 * runtime in a way TypeScript cannot resolve.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import * as ts from "typescript";

/** One module the boundary check must keep pure. */
export interface PurityTarget {
    /** The module's absolute path. */
    file: string;
}

/** Resolve one module specifier for a problem report. */
type Classify = (
    from: string,
    specifier: string,
    chain: readonly string[],
) => void;

/** Report one problem at a source location. */
type Report = (node: ts.Node, message: string) => void;

/** Builtins with no ambient effect that a pure calculation may use. */
const ALLOWED_BUILTINS = new Set(["node:path", "node:util", "node:crypto"]);

/** Calls that reach an ambient source or an external effect. */
const FORBIDDEN_CALLS = new Set([
    "setTimeout",
    "setInterval",
    "setImmediate",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
]);

/** Cryptographic calls that sample randomness even inside an allowed module. */
const FORBIDDEN_CRYPTO = new Set([
    "randomBytes",
    "randomUUID",
    "randomFill",
    "randomFillSync",
    "randomInt",
    "generateKey",
    "generateKeySync",
    "generateKeyPair",
    "generateKeyPairSync",
]);

/** Resolve one relative module specifier to a TypeScript source file. */
function resolveSource(from: string, specifier: string): string | null {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base, `${base}.ts`, resolve(base, "index.ts")]) {
        if (existsSync(candidate) && extname(candidate) === ".ts") {
            return candidate;
        }
    }
    return null;
}

/** Whether an import declaration is fully erased at runtime. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
    const clause = node.importClause;
    if (clause === undefined || clause.isTypeOnly) return true;
    if (clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return true;
    if (ts.isNamespaceImport(bindings)) return false;
    return bindings.elements.every((element) => element.isTypeOnly);
}

/** Whether an export declaration is fully erased at runtime. */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
    if (node.isTypeOnly) return true;
    return node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.every((element) => element.isTypeOnly)
        : false;
}

/** The simple identifier a call expression names, if any. */
function calledName(expression: ts.Expression): string | null {
    return ts.isIdentifier(expression) ? expression.text : null;
}

/** Report a dynamic import that cannot be resolved statically. */
function checkDynamicImport(
    node: ts.CallExpression,
    classify: Classify,
    from: string,
    chain: readonly string[],
    report: Report,
): void {
    const argument = node.arguments[0];
    if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        classify(from, argument.text, chain);
        return;
    }
    report(node, "unresolvable dynamic import in a pure module");
}

/** Report ambient and random calls named directly. */
function checkNamedCall(
    name: string,
    node: ts.CallExpression,
    report: Report,
): void {
    if (FORBIDDEN_CALLS.has(name)) {
        report(node, `calls ambient or effectful function ${name}`);
    }
    if (FORBIDDEN_CRYPTO.has(name)) {
        report(node, `calls non-deterministic ${name}`);
    }
}

/** Report `Date.now()` and `Math.random()` on a member call. */
function checkMemberCall(
    expression: ts.PropertyAccessExpression,
    node: ts.CallExpression,
    report: Report,
): void {
    const owner = expression.expression;
    if (!ts.isIdentifier(owner)) return;
    if (owner.text === "Date" && expression.name.text === "now") {
        report(node, "reads the ambient clock");
    }
    if (owner.text === "Math" && expression.name.text === "random") {
        report(node, "reads the ambient random source");
    }
}

/** Report one call expression's ambient or effectful access. */
function checkCall(
    node: ts.CallExpression,
    classify: Classify,
    from: string,
    chain: readonly string[],
    report: Report,
): void {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        checkDynamicImport(node, classify, from, chain, report);
        return;
    }
    const name = calledName(node.expression);
    if (name !== null) checkNamedCall(name, node, report);
    if (ts.isPropertyAccessExpression(node.expression)) {
        checkMemberCall(node.expression, node, report);
    }
}

/** Report an argument-less `new Date()`. */
function checkNew(node: ts.NewExpression, report: Report): void {
    if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Date" &&
        (node.arguments === undefined || node.arguments.length === 0)
    ) {
        report(node, "reads the ambient clock");
    }
}

/** Report any read of ambient process state. */
function checkProcessAccess(
    node: ts.PropertyAccessExpression,
    report: Report,
): void {
    if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "process"
    ) {
        report(node, `reads ambient process state (${node.name.text})`);
    }
}

/**
 * Check one explicit list of modules for ambient access and external effects.
 * @param targets The modules to keep pure.
 * @returns Problems, including the importing chain; empty means pure.
 */
export function purityProblems(targets: readonly PurityTarget[]): string[] {
    const problems: string[] = [];
    const visited = new Set<string>();

    const visit = (file: string, chain: readonly string[]): void => {
        if (visited.has(file)) return;
        visited.add(file);
        let text: string;
        try {
            text = readFileSync(file, "utf8");
        } catch (error) {
            problems.push(
                `${file}: cannot read module: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
        }
        const source = ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const report: Report = (node, message) => {
            const line =
                source.getLineAndCharacterOfPosition(node.getStart(source))
                    .line + 1;
            problems.push(`${[...chain, `${line}`].join(":")}: ${message}`);
        };
        const classify: Classify = (from, specifier, at) => {
            if (specifier.startsWith(".")) {
                const resolved = resolveSource(from, specifier);
                if (resolved === null) {
                    problems.push(
                        `${at.join(" -> ")}: cannot resolve import ${specifier}`,
                    );
                    return;
                }
                visit(resolved, [...at, resolved]);
                return;
            }
            if (specifier.startsWith("node:")) {
                if (ALLOWED_BUILTINS.has(specifier)) return;
                problems.push(
                    `${at.join(" -> ")}: imports effectful or ambient builtin ${specifier}`,
                );
                return;
            }
            problems.push(
                `${at.join(" -> ")}: imports external module ${specifier}; purity is not statically known`,
            );
        };

        const walk = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)) {
                classify(
                    file,
                    (node.moduleSpecifier as ts.StringLiteral).text,
                    chain,
                );
            } else if (
                ts.isExportDeclaration(node) &&
                !isTypeOnlyExport(node) &&
                node.moduleSpecifier !== undefined
            ) {
                classify(
                    file,
                    (node.moduleSpecifier as ts.StringLiteral).text,
                    chain,
                );
            } else if (ts.isCallExpression(node)) {
                checkCall(node, classify, file, chain, report);
            } else if (ts.isNewExpression(node)) {
                checkNew(node, report);
            } else if (ts.isPropertyAccessExpression(node)) {
                checkProcessAccess(node, report);
            }
            ts.forEachChild(node, walk);
        };
        walk(source);
    };

    for (const target of targets) {
        visit(target.file, [target.file]);
    }
    return problems;
}
