import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Arm, Campaign } from "../../contracts/types.ts";

/** One plugin entry handed to OpenCode. */
export interface PluginEntry {
    /** The package value. */
    package: string;
    /** The options value. */
    options?: unknown;
}

/** The OpenCode configuration OTC writes for one arm. */
export interface OpencodeConfig {
    /** The schema value. */
    $schema: string;
    /** The model value. */
    model: string;
    /** The plugins value. */
    plugins?: PluginEntry[];
    /** The permissions value. */
    permissions?: Record<string, unknown>;
}

/**
 * Build the arm's non-secret OpenCode configuration.
 * @param campaign The normalised campaign.
 * @param arm The selected arm.
 * @returns The configuration object written into the read-only config home.
 */
export function opencodeConfig(campaign: Campaign, arm: Arm): OpencodeConfig {
    const config: OpencodeConfig = {
        $schema: "https://opencode.ai/config.json",
        model: campaign.runtime.provider.model,
    };
    if (arm.plugins !== undefined && arm.plugins.length > 0) {
        config.plugins = arm.plugins.map((plugin) => ({
            package: `/subjects/plugins/${plugin.id}`,
            ...(plugin.options === undefined
                ? {}
                : { options: plugin.options }),
        }));
    }
    if (campaign.permissions !== undefined) {
        config.permissions = campaign.permissions;
    }
    return config;
}

/**
 * The exact `opencode run` argv. This is the argv recorded in evidence and
 * the argv actually spawned.
 * @param options Model route, title, prompt and logging choice.
 * @returns The complete argv (without the binary).
 * @param options.model The model value.
 * @param options.title The title value.
 * @param options.prompt The prompt value.
 * @param options.printLogs The printLogs value.
 */
export function opencodeRunArgs(options: {
    model: string;
    title: string;
    prompt: string;
    printLogs?: boolean;
}): string[] {
    return [
        "run",
        "--standalone",
        "--auto",
        "--archived",
        "--title",
        options.title,
        "--model",
        options.model,
        "--format",
        "json",
        ...(options.printLogs === true ? ["--print-logs"] : []),
        options.prompt,
    ];
}

/**
 * The provider overlay passed inline through `OPENCODE_CONFIG_CONTENT`. Only
 * non-secret routing belongs here; credentials travel by environment name.
 * @param campaign The frozen campaign.
 * @returns JSON text, or null when the campaign declares no overlay.
 */
export function providerOverlay(campaign: Campaign): string | null {
    const overlay = campaign.runtime.provider.overlay;
    return overlay === undefined ? null : JSON.stringify(overlay);
}

/**
 * Write the read-only config home for one arm: its OpenCode configuration.
 * Skill bundles are staged into the same tree by the trial runner.
 * @param trialDirectory The trial's private directory.
 * @param campaign The normalised campaign.
 * @param arm The selected arm.
 * @returns The config-home path.
 */
export function writeConfigHome(
    trialDirectory: string,
    campaign: Campaign,
    arm: Arm,
): string {
    const configHome = join(trialDirectory, "config-home");
    const opencode = join(configHome, "opencode");
    mkdirSync(join(opencode, "skills"), { recursive: true });
    writeFileSync(
        join(opencode, "opencode.json"),
        `${JSON.stringify(opencodeConfig(campaign, arm), null, 2)}\n`,
        "utf8",
    );
    return configHome;
}

/**
 * Environment for one headless session. Ambient OpenCode session identity is
 * removed; credentials and routing arrive only through declared names.
 * @param base The host environment.
 * @param options Config home, trial data/cache directories, overlay and names
 *   whose values are passed through.
 * @returns A fresh environment object.
 * @param options.configHome The configHome value.
 * @param options.dataHome The dataHome value.
 * @param options.cacheHome The cacheHome value.
 * @param options.overlay The overlay value.
 * @param options.passthrough The passthrough value.
 */
export function sessionEnv(
    base: NodeJS.ProcessEnv,
    options: {
        configHome: string;
        dataHome: string;
        cacheHome: string;
        overlay: string | null;
        passthrough: readonly string[];
    },
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    for (const key of [
        "OPENCODE_SESSION_ID",
        "OPENCODE_TERMINAL",
        "OPENCODE",
        "AI_AGENT",
        "OPENCODE_CONFIG_CONTENT",
    ]) {
        delete env[key];
    }
    env.HOME = "/tmp/agent-home";
    env.XDG_CONFIG_HOME = options.configHome;
    env.XDG_DATA_HOME = options.dataHome;
    env.XDG_CACHE_HOME = options.cacheHome;
    if (options.overlay !== null) {
        env.OPENCODE_CONFIG_CONTENT = options.overlay;
    }
    for (const name of options.passthrough) {
        const value = base[name];
        if (value !== undefined) env[name] = value;
    }
    return env;
}
