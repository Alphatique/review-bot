import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/main.ts'],
	outDir: 'dist',
	format: 'esm',
	platform: 'node',
	target: 'node24',
	external: ['@anthropic-ai/claude-agent-sdk'],
	clean: false,
	dts: false,
	sourcemap: false,
	outExtensions: () => ({ js: '.mjs' }),
	outputOptions: { entryFileNames: 'index.mjs' },
});
