import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // ---------------------------------------------------------------------------
  // Analytics guardrail: ban direct sa_event / sa_pageview calls.
  // All Simple Analytics calls MUST go through the track() / trackPageview()
  // wrappers in frontend/src/app/lib/analytics.ts — they enforce the privacy
  // contract (allowlisted keys, path normalisation, no PII, dev-mode no-op).
  // ---------------------------------------------------------------------------
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      // The wrapper itself — the ONLY place sa_event/sa_pageview may be called.
      "src/app/lib/analytics.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='sa_event']",
          message:
            "Direct sa_event() calls are banned. Use track() from '@/app/lib/analytics' instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name='sa_event']",
          message:
            "Direct window.sa_event() calls are banned. Use track() from '@/app/lib/analytics' instead.",
        },
        {
          selector:
            "CallExpression[callee.name='sa_pageview']",
          message:
            "Direct sa_pageview() calls are banned. Use trackPageview() from '@/app/lib/analytics' instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name='sa_pageview']",
          message:
            "Direct window.sa_pageview() calls are banned. Use trackPageview() from '@/app/lib/analytics' instead.",
        },
      ],
    },
  },
]);

export default eslintConfig;
