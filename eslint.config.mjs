import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  {
    files: ["e2e/**/*.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: [
      "e2e/**/*.ts",
      "e2e/**/*.tsx",
      "e2e/**/*.js",
      "e2e/**/*.jsx",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@playwright/test",
          message: "Import test and expect from ./fixtures so same-origin /api failures fail closed.",
        }],
      }],
    },
  },
  {
    files: ["e2e/fixtures.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    ".vinext/**",
    ".cloudflare/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    ".playwright-mcp/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
