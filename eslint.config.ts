import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
	{ ignores: ["dist/**", "dist-onprem/**", "dist-onprem-package/**", "coverage/**", ".cbs-probe/**"] },
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2022,
			globals: globals.browser,
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
			"jsx-a11y": jsxA11y,
		},
		rules: {
			...js.configs.recommended.rules,
			...tsPlugin.configs["eslint-recommended"].overrides[0].rules,
			...tsPlugin.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		files: ["**/*.test.{ts,tsx}", "**/test-setup.ts"],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
];
