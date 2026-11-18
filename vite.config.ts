import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The transcription worker loads the pitch model on demand.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Cross-origin isolation lets the models use several threads. 'credentialless'
  // still allows the piano samples to load from their CDN.
  server: { headers: isolation },
  preview: { headers: isolation },
})
