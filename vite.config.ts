import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(() => {
  // Check for GEMINI_API_KEY, legacy API_KEY, and VITE_API_KEY
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_API_KEY;
  const hasKey = !!apiKey;
  console.log(`[Vite Build] GEMINI_API_KEY is: ${hasKey ? 'PRESENT' : 'MISSING'}`);

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
    // Define import.meta.env.VITE_API_KEY to be available in the browser code.
    // This maps the system environment variable (API_KEY or VITE_API_KEY) to the Vite frontend variable.
    define: {
      'import.meta.env.VITE_API_KEY': JSON.stringify(apiKey || ""),
    },
  };
})