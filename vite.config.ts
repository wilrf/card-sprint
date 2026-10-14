import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// GitHub Pages serves the site from /card-sprint/. SINGLE=1 inlines everything
// (sql.js wasm included) into one portable dist-single/index.html.
const single = process.env.SINGLE === '1';

export default defineConfig({
  base: single ? './' : '/card-sprint/',
  plugins: single ? [viteSingleFile()] : [],
  build: single
    ? { target: 'es2022', outDir: 'dist-single', assetsInlineLimit: Infinity }
    : { target: 'es2022' },
});
