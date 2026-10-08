// Shared config loader for all k6 scenario scripts.
// k6 does not read .env files automatically — values must be passed via
// `-e NAME=value` or already exported in the shell environment. See
// README.md for exact invocation examples (dotenv-style loading per shell).
import { fail } from 'k6'

function required(name) {
  const value = __ENV[name]
  if (!value) {
    fail(
      `Missing required env var "${name}". Set it with -e ${name}=... or export it before running k6. See load-tests/.env.example.`
    )
  }
  return value
}

function optional(name, fallback) {
  return __ENV[name] || fallback
}

export const SUPABASE_URL = required('SUPABASE_URL').replace(/\/+$/, '')
export const SUPABASE_ANON_KEY = required('SUPABASE_ANON_KEY')
export const GAME_CODE = optional('GAME_CODE', 'LOADTEST')
export const GAME_ID = optional('GAME_ID', '') // required by host-only scenarios only
export const HOST_SECRET = optional('HOST_SECRET', '') // required by host-only scenarios only

export const MAX_VUS = parseInt(optional('MAX_VUS', '100'), 10)
export const SOAK_DURATION_MIN = parseInt(optional('SOAK_DURATION_MIN', '25'), 10)

// A safety rail: requires the operator to explicitly confirm, by project
// ref, which Supabase project they intend to run load against. This is
// deliberately NOT a hostname "looks like prod" heuristic (that approach
// failed in practice — this project's own production ref has no "prod"-
// like substring) — instead it's an explicit allowlist the operator must
// set themselves, so running against the wrong project requires an active,
// visible mistake (copying the wrong ref), not just an absent flag.
//
// Project status as of the last authorized run: `otybqfimodvglcwsaelx` IS
// this app's production Supabase project, but the app has no real users
// yet, and load testing against it has been explicitly authorized under
// strict test-data isolation (dedicated game, TEST_-prefixed synthetic
// players, scoped-only cleanup — see GAME_CODE/GAME_ID conventions in
// README.md). That authorization is scoped to "before real users exist" —
// once real players are using the app, load testing must move to a
// separate staging project and this allowlist should be updated
// accordingly.
export const CONFIRMED_PROJECT_REFS = optional('CONFIRMED_PROJECT_REFS', 'otybqfimodvglcwsaelx')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export function assertSafeTarget() {
  // k6's JS runtime does not provide a global URL constructor, so the host
  // is extracted with a simple regex instead of new URL(...).host.
  const match = /^https?:\/\/([^/]+)/i.exec(SUPABASE_URL)
  const host = match ? match[1] : SUPABASE_URL // e.g. otybqfimodvglcwsaelx.supabase.co
  const ref = host.split('.')[0]
  if (!CONFIRMED_PROJECT_REFS.includes(ref)) {
    fail(
      `SUPABASE_URL's project ref ("${ref}") is not in CONFIRMED_PROJECT_REFS ` +
        `("${CONFIRMED_PROJECT_REFS.join(', ')}"). Refusing to run. ` +
        `Add this ref to CONFIRMED_PROJECT_REFS only after explicitly confirming ` +
        `with whoever owns this Supabase project that load testing against it is authorized.`
    )
  }
}

export const REST_URL = `${SUPABASE_URL}/rest/v1`

export function headers(extra) {
  return Object.assign(
    {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    extra || {}
  )
}
