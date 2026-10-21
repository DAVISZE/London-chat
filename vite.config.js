import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES === 'true' ? '/London-chat/' : '/',
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
