import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCampaign } from "../../src/campaign/prepare.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "fixtures", "skill-basic");

describe("V2 local plugin staging", () => {
    it("stages the documented index.js entry point by default", () => {
        // Arrange
        const dir = mkdtempSync(join(tmpdir(), "otc-plugin-stage-"));
        try {
            cpSync(FIXTURE, dir, { recursive: true });
            const plugin = join(dir, "plugin", "otc-probe");
            mkdirSync(plugin, { recursive: true });
            writeFileSync(
                join(plugin, "package.json"),
                `${JSON.stringify({
                    name: "otc-probe",
                    version: "1.0.0",
                    type: "module",
                    exports: { ".": "./index.js" },
                })}\n`,
                "utf8",
            );
            writeFileSync(
                join(plugin, "index.js"),
                "export default { id: 'probe', async setup() {} };\n",
                "utf8",
            );
            const campaignPath = join(dir, "campaign.json");
            const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
                subjects: Array<{ plugins?: unknown[] }>;
            };
            campaign.subjects[0]!.plugins = [
                { id: "otc-probe", path: "plugin/otc-probe" },
            ];
            writeFileSync(
                campaignPath,
                `${JSON.stringify(campaign, null, 2)}\n`,
                "utf8",
            );
            const root = join(dir, "root");

            // Act
            const prepared = prepareCampaign(campaignPath, root);

            // Assert
            assert.equal(
                prepared.ok,
                true,
                prepared.ok ? "" : prepared.problems.join("; "),
            );
            assert.equal(
                existsSync(
                    join(
                        root,
                        "prepare",
                        "subjects",
                        "skill-only",
                        "plugins",
                        "otc-probe",
                        "index.js",
                    ),
                ),
                true,
                "a V2 local plugin's index.js must be staged",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
