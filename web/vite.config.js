import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative asset paths, so the build works from any sub-path (GitHub Pages serves it under /<repo>/).
export default defineConfig({
  base: './',
  plugins: [react()],
  // The wallet selector's React hook ships its own React; two copies break hooks. Use ours.
  resolve: { dedupe: ['react', 'react-dom'] },
  define: { global: 'globalThis' },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 4000 },
});
