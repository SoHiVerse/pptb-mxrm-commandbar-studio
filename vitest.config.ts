import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		include: ["src/**/*.test.{ts,tsx}"],
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
		globals: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			thresholds: {
				statements: 80,
				functions: 80,
				lines: 80,
				branches: 75,
			},
		},
	},
});
