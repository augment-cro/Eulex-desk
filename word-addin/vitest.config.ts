import { defineConfig } from "vitest/config";

/**
 * Unit tests cover the pure logic modules (wordDiff, textMatch) and the
 * OOXML parser. Most run in a plain Node environment; the OOXML test opts
 * into jsdom via a `// @vitest-environment jsdom` pragma because it needs
 * `DOMParser`.
 */
export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node",
    },
});
