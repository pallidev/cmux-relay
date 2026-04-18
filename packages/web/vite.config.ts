import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __VITE_RELAY_WS_URL__: JSON.stringify(process.env.VITE_RELAY_WS_URL || ''),
    __VITE_RELAY_HTTP_URL__: JSON.stringify(process.env.VITE_RELAY_HTTP_URL || ''),
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
