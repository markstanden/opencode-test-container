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

/** Builtins with no ambient effect that a pure calculation may use. */
const ALLOWED_BUILTINS = new Set(["node:path", "node:util", "node:crypto"]);

/** Builtins that reach the clock, randomness, environment or an external effect. */
const FORBIDDEN_BUILTINS = new Set([
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "node:net",
    "node:http",
    "node:https",
    "node:tls",
    "node:dns",
    "node:os",
    "node:process",
    "node:worker_threads",
    "node:cluster",
    "node:vm",
    "node:module",
    "node:readline",
    "node:stream",
    "node:zlib",
    "node:timers",
]);

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
    for (const candidate of [
        base,
        `${base}.ts`,
        resolve(base, "index.ts"),
    ]) {
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
    return node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.every((element) => element.isTypeOnly)
        : false;
}

/** The identifier a call or new expression names, when it is a simple name. */
function calledName(expression: ts.Expression): string | null {
    if (ts.isIdentifier(expression)) return expression.text;
    return null;
}

/**
 * Check one explicit list of modules for ambient access and external effects.
 * @param targets The modules to keep pure.
 * @returns Problems, including the importing chain; empty means pure.
 */
export function purityProblems(targets: readonly PurityTarget[]): string[] {
    const problems: string[] = [];
    const visited = new Set<string>();

    const classify = (
        from: string,
        specifier: string,
        chain: readonly string[],
    ): string | null => {
        if (specifier.startsWith(".")) {
            const resolved = resolveSource(from, specifier);
            if (resolved === null) {
                problems.push(
                    `${chain.join(" -> ")}: cannot resolve import ${specifier}`,
                );
                return null;
            }
            visit(resolved, [...chain, resolved]);
            return null;
        }
        if (specifier.startsWith("node:")) {
            if (ALLOWED_BUILTINS.has(specifier)) return null;
            problems.push(
                `${chain.join(" -> ")}: imports effectful or ambient builtin ${specifier}`,
            );
            return null;
        }
        if (FORBIDDEN_BUILTINS.has(specifier)) {
            problems.push(
                `${chain.join(" -> ")}: imports effectful builtin ${specifier}`,
            );
            return null;
        }
        problems.push(
            `${chain.join(" -> ")}: imports external module ${specifier}; purity is not statically known`,
        );
        return null;
    };

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
        const at = (node: ts.Node): string => {
            const line =
                source.getLineAndCharacterOfPosition(node.getStart(source))
                    .line + 1;
            return `${chain.join(" -> ")}:${line}`;
        };

        const walk = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                if (!isTypeOnlyImport(node)) {
                    classify(
                        file,
                        (node.moduleSpecifier as ts.StringLiteral).text,
                        chain,
                    );
                }
            } else if (ts.isExportDeclaration(node)) {
                if (!isTypeOnlyExport(node) && node.moduleSpecifier) {
                    classify(
                        file,
                        (node.moduleSpecifier as ts.StringLiteral).text,
                        chain,
                    );
                }
            } else if (ts.isCallExpression(node)) {
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const argument = node.arguments[0];
                    if (
                        argument !== undefined &&
                        ts.isStringLiteralLike(argument)
                    ) {
                        classify(file, argument.text, chain);
                    } else {
                        problems.push(
                            `${at(node)}: unresolvable dynamic import in a pure module`,
                        );
                    }
                } else {
                    const name = calledName(node.expression);
                    if (name !== null && FORBIDDEN_CALLS.has(name)) {
                        problems.push(
                            `${at(node)}: calls ambient or effectful function ${name}`,
                        );
                    }
                    if (name !== null && FORBIDDEN_CRYPTO.has(name)) {
                        problems.push(
                            `${at(node)}: calls non-deterministic ${name}`,
                        );
                    }
                    if (ts.isPropertyAccessExpression(node.expression)) {
                        const owner = node.expression.expression;
                        if (
                            ts.isIdentifier(owner) &&
                            owner.text === "Date" &&
                            node.expression.name.text === "now"
                        ) {
                            problems.push(
                                `${at(node)}: reads the ambient clock`,
                            );
                        }
                        if (
                            ts.isIdentifier(owner) &&
                            owner.text === "Math" &&
                            node.expression.name.text === "random"
                        ) {
                            problems.push(
                                `${at(node)}: reads the ambient random source`,
                            );
                        }
                    }
                }
            } else if (ts.isNewExpression(node)) {
                if (
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "Date" &&
                    (node.arguments === undefined ||
                        node.arguments.length === 0)
                ) {
                    problems.push(`${at(node)}: reads the ambient clock`);
                }
            } else if (ts.isPropertyAccessExpression(node)) {
                if (
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "process"
                ) {
                    problems.push(
                        `${at(node)}: reads ambient process state (${node.name.text})`,
                    );
                }
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
