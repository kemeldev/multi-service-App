import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',            // reachable from other machines / containers
      port: Number(env.APP_PORT || 5173),
      strictPort: true,
    },
    preview: {
      host: '0.0.0.0',
      port: Number(env.APP_PORT || 5173),
      strictPort: true,
    },
  };
});
