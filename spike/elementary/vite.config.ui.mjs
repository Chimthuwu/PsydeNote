// Build config for the P7 plugin UI (todo.md §73).
//
// Bundles the REAL Faze React components from ../../src/renderer into a single
// self-contained index.html (JS + CSS inlined by vite-plugin-singlefile) that
// the JUCE plugin's choc webview loads from embedded binary data. No second
// copy of the components — they're imported straight from src/renderer and
// driven by ui/bridge.ts instead of the Web-Audio SynthEngine.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: resolve(import.meta.dirname, 'ui'),
  base: './',
  plugins: [react(), viteSingleFile()],
  // The components live outside this project's root (src/renderer, src/shared).
  server: { port: 5175, fs: { allow: [repoRoot] } },
  build: {
    outDir: resolve(import.meta.dirname, 'ui/dist'),
    emptyOutDir: true,
    // singlefile wants everything inlined; keep the chunking trivial.
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
