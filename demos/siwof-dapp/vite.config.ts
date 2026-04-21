import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The SDK's EVM adapter dynamically imports ethers as an optional peerDep.
  // Skip Vite's dep-optimization for that dynamic path.
  optimizeDeps: { exclude: ['ethers'] },
});
