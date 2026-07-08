import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat ESLint config (ESLint 9 + typescript-eslint 8).
 *
 * Scope is intentionally `src/**` only — build configs (webpack, postcss,
 * tailwind, babel) are CommonJS and excluded. Several stylistic rules are
 * downgraded to warnings so the lint step stays green on the existing code
 * while still surfacing issues; `npm run lint` does not pass
 * `--max-warnings`, so only errors fail CI.
 */
export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "*.config.js",
            "*.config.mjs",
            "*.config.ts",
        ],
    },
    { linterOptions: { reportUnusedDisableDirectives: "off" } },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.{ts,tsx}"],
        plugins: { "react-hooks": reactHooks },
        languageOptions: {
            globals: {
                ...globals.browser,
                Office: "readonly",
                Word: "readonly",
                OfficeExtension: "readonly",
                OfficeRuntime: "readonly",
            },
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
            // TypeScript handles undefined-symbol detection.
            "no-undef": "off",
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-constant-condition": ["error", { checkLoops: false }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
        },
    },
);
