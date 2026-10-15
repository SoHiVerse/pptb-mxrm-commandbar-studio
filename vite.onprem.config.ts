import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Separate, additive Dynamics 365 CE on-premises web-resource build.
 * CRM hosts the HTML at <prefix>_/commandbarstudio/onprem.html; relative asset
 * paths therefore resolve to other published web resources in that folder.
 */
export default defineConfig({
	root: projectRoot,
	base: './',
	publicDir: false,
	plugins: [react()],
	resolve: {
		alias: { '@': path.resolve(projectRoot, 'src') },
	},
	build: {
		outDir: path.resolve(projectRoot, 'dist-onprem'),
		emptyOutDir: true,
		target: ['chrome108', 'firefox115', 'safari16'],
		sourcemap: false,
		// Fonts/wasm/other unsupported CRM web-resource types become data URIs
		// within supported CSS/JS output, rather than broken binary resources.
		assetsInlineLimit: Number.MAX_SAFE_INTEGER,
		cssCodeSplit: true,
		manifest: false,
		rollupOptions: {
			input: path.resolve(projectRoot, 'onprem.html'),
			output: {
				manualChunks: {
					monaco: ['@monaco-editor/react', 'monaco-editor'],
					'fluent-ui': ['@fluentui/react-components'],
					'fluent-icons': ['@fluentui/react-icons'],
					dnd: ['@dnd-kit/core', '@dnd-kit/sortable'],
				},
			},
		},
	},
});
