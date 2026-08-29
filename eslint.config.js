import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/workspace/**",
      ".artifacts/**",
      ".runtime/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,cts,mts}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-useless-escape": "off",
    },
  },
  {
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-wrappers": "error",
      "no-template-curly-in-string": "error",
      "no-unreachable-loop": "error",
      "no-useless-assignment": "off",
      "prefer-const": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["apps/server/src/prompts/module-agent.ts"],
    rules: {
      "no-template-curly-in-string": "off",
    },
  },
);
