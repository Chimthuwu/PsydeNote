import { defineConfig } from 'vite';

// `optimizeDeps.entries` pinned to the one real entry so Vite's dep scanner
// doesn't crawl into plugin/elementary/ (the JUCE-side submodule) and choke on
// its internal test HTML files. `base: './'` keeps the build relocatable.
export default defineConfig({
  base: './',
  server: { port: 5174, open: true },
  optimizeDeps: { entries: ['index.html'] },
});
