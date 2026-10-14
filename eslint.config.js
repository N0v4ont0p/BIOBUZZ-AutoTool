import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";
import svelteConfig from "./svelte.config.js";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    files: ["**/*.svelte"],
    rules: {
      // Misreads `prop = $bindable(default)` in `$props()` destructuring as a
      // dead assignment. The default is part of the prop contract, not dead code.
      "no-useless-assignment": "off",
    },
  },
  {
    rules: {
      // The codebase leans on `any` for Two.js scene objects and parsed
      // project JSON; surface those as warnings rather than errors.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: [
      "dist/",
      "out/",
      "public/",
      "node_modules/",
      "*.config.js",
      "*.config.ts",
      "vite.config.d.ts",
    ],
  },
);
