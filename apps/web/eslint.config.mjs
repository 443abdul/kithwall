import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React Compiler advisories: these flag common, correct patterns (resetting state when an id
      // changes, reading Date.now() for relative times). Kept visible as warnings, not build blockers.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      // Security: user content must never be injected as HTML (CSP enforces Trusted Types too).
      "react/no-danger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".next-*/**",
  ]),
]);

export default eslintConfig;
