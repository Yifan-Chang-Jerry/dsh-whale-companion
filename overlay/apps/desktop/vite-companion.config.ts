/** Build the companion renderer after the shared Client packages have been bundled. */
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  configFile: false,
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  esbuild: { jsx: 'automatic' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'companion-assets',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'index.html', source: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob: https: http:; font-src \'self\' data:; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>DSH Companion</title><link rel="stylesheet" href="./companion.css"></head><body><div id="root"></div><script src="./live2d/live2dcubismcore.min.js"></script><script type="module" src="./companion.js"></script></body></html>` })
    },
  }],
  build: {
    outDir: 'lib/companion', emptyOutDir: true, cssCodeSplit: true,
    rollupOptions: {
      input: { companion: fileURLToPath(new URL('./src/client/companion.tsx', import.meta.url)) },
      output: {
        entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: asset => asset.names.includes('companion.css') ? 'companion.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
