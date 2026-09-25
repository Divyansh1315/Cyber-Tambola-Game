/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xxxxxxxxxxxx.supabase.co */
  readonly VITE_SUPABASE_URL?: string
  /** Supabase anon/public key — browser-safe, never the service_role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
