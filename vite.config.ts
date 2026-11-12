import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The transcription worker loads the pitch model on demand.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
