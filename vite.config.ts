import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // Relative asset URLs: behind the portal the app lives under /trendlogic/
    // (same pattern as trend / signal / ai-chatbot).
    base: './',
    // public/ holds only generated media (public/videos/*.mp4|mp3 rendered
    // shorts). The express server serves /videos/... from it directly in dev
    // AND production, so vite must not copy it into dist/ (it would double
    // every render in the deploy bundle).
    publicDir: false as const,
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
