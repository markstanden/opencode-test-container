import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Every Markdown file under a directory, recursively. */
function markdownUnder(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort();
}

/** The Markdown a consumer can reach from the package or repository root. */
const documents = [
    join(repoRoot, "README.md"),
    join(repoRoot, "container", "README.md"),
    ...markdownUnder(join(repoRoot, "docs")),
    ...markdownUnder(join(repoRoot, "examples")),
];

/** Remove inline code spans, matched by an opening and closing backtick run. */
function stripInlineCode(text: string): string {
    let kept = "";
    let index = 0;
    while (index < text.length) {
        const open = text.indexOf("`", index);
        if (open === -1) return kept + text.slice(index);
        let run = 1;
        while (text[open + run] === "`") run += 1;
        const close = text.indexOf("`".repeat(run), open + run);
        if (close === -1) return kept + text.slice(index);
        kept += text.slice(index, open);
        index = close + run;
    }
    return kept;
}

/** Strip fenced blocks and inline code so examples are not read as links. */
function proseOf(markdown: string): string {
    const lines = markdown.split("\n");
    const kept: string[] = [];
    let fenced = false;
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (!fenced) kept.push(stripInlineCode(line));
    }
    return kept.join("\n");
}

/** Relative link destinations in one Markdown document. */
function relativeLinks(markdown: string): string[] {
    const links: string[] = [];
    for (const match of proseOf(markdown).matchAll(
        /!?\[[^[\]]*\]\(([^)\s]+)\)/g,
    )) {
        const destination = match[1];
        if (
            destination === undefined ||
            destination.startsWith("#") ||
            destination.startsWith("//") ||
            /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)
        ) {
            continue;
        }
        const path = destination.split("#")[0]?.split("?")[0];
        if (path !== undefined && path !== "") links.push(path);
    }
    return links;
}

/** The guidance entry point, which the recursive walk must find. */
const guidanceIndex = join(repoRoot, "docs", "guidance", "README.md");

describe("consumer-facing Markdown links", () => {
    it("discovers the guidance index through the recursive walk", () => {
        assert.ok(
            documents.includes(guidanceIndex),
            "docs/guidance/README.md is missing from the discovered set",
        );
    });

    it("reads relative links from the guidance index", () => {
        assert.ok(
            relativeLinks(readFileSync(guidanceIndex, "utf8")).length >= 5,
            "the guidance index yielded fewer relative links than expected",
        );
    });

    for (const document of documents) {
        const links = relativeLinks(readFileSync(document, "utf8"));
        if (links.length === 0) continue;

        it(`${relative(repoRoot, document)} resolves every relative link`, () => {
            const unresolved = links
                .map((link) => ({
                    link,
                    target: resolve(dirname(document), link),
                }))
                .filter(({ target }) => !existsSync(target))
                .map(({ link }) => link);

            assert.deepEqual(
                unresolved,
                [],
                `${relative(repoRoot, document)} has unresolved links: ${unresolved.join(", ")}`,
            );
        });
    }
});
