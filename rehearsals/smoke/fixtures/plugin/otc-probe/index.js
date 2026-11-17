/**
 * Deterministic OpenCode plugin used only by the OTC smoke suite.
 *
 * It exports a V2 default plugin definition, registers one tool and returns
 * the configured marker so the smoke test can prove options reached the
 * plugin and that OpenCode actually dispatched the tool.
 */
export default {
    id: "otc-smoke-probe",
    /**
     * Register the deterministic probe tool.
     * @param {object} ctx The plugin context.
     * @returns {Promise<void>} Resolves after registration.
     */
    async setup(ctx) {
        const marker =
            typeof ctx.options?.marker === "string"
                ? ctx.options.marker
                : "missing-options";
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "otc_probe",
                description: "Emit the deterministic OTC smoke marker.",
                options: { codemode: false },
                input: {
                    type: "object",
                    properties: {
                        label: { type: "string" },
                    },
                    additionalProperties: false,
                },
                execute: async (input) => ({
                    content: `OTC_PLUGIN_TOOL_OK:${marker}:${String(
                        input.label ?? "no-label",
                    )}`,
                }),
            });
        });
    },
};
