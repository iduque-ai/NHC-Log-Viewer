/// <reference types="vite/client" />

// This file provides TypeScript definitions for Vite's environment variables.
// By extending the ImportMetaEnv interface, we can get type-safe access to
// our custom environment variables like `import.meta.env.VITE_API_KEY`.

interface ImportMetaEnv {
  readonly VITE_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css';
