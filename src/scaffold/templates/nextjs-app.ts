// The nextjs-app starter. Small on purpose: enough to build, deploy and carry the marker the
// hosting.deployed check looks for.

import type { Manifest } from '../../manifest/schema'

export const MARKER_NAME = 'cimiento-project'

/**
 * The baseline migration every scaffold with a database starts with. The database.migrated check
 * applies it and queries its table, which proves migrations really reach the database. Row level
 * security is on with no policy, so the table is invisible to the public API.
 */
/**
 * A value as a TypeScript string literal, and as JSX text. A project name is the person's own
 * words, quotes and ampersands included, so it is never pasted into code raw (BUG-79).
 */
export function tsString(value: string): string {
  return JSON.stringify(value)
}

export function jsxText(value: string): string {
  return `{${JSON.stringify(value)}}`
}

export const BASELINE_TABLE = 'cimiento_baseline'
export const BASELINE_FILE = `20250101000000_${BASELINE_TABLE}.sql`
export const BASELINE_SQL = `-- cimiento baseline. cimiento doctor queries this table to prove migrations reach the database.
create table if not exists public.${BASELINE_TABLE} (
  id smallint primary key default 1 check (id = 1),
  created_at timestamptz not null default now()
);

alter table public.${BASELINE_TABLE} enable row level security;

insert into public.${BASELINE_TABLE} (id) values (1) on conflict (id) do nothing;
`

export function nextjsAppFiles(m: Manifest): Record<string, string> {
  const usesSupabase = m.slots.database === 'supabase' || m.slots.auth === 'supabase'
  const usesInngest = m.slots.jobs === 'inngest'
  const usesTurnstile = m.slots.bot_protection === 'turnstile'
  const usesAnthropic = m.slots.ai === 'anthropic'
  return {
    'package.json': `${JSON.stringify(
      {
        name: m.slug,
        version: '0.1.0',
        private: true,
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
          lint: 'next lint',
        },
        dependencies: {
          next: '^15.0.0',
          react: '^19.0.0',
          'react-dom': '^19.0.0',
          ...(usesSupabase ? { '@supabase/supabase-js': '^2.45.0' } : {}),
          ...(usesInngest ? { inngest: '^3.54.0' } : {}),
          ...(usesAnthropic ? { '@anthropic-ai/sdk': '^0.135.0' } : {}),
        },
        devDependencies: {
          '@types/node': '^22.7.4',
          '@types/react': '^19.0.0',
          '@types/react-dom': '^19.0.0',
          typescript: '^5.6.2',
        },
      },
      null,
      2,
    )}\n`,

    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'ES2022'],
          allowJs: false,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    )}\n`,

    'next.config.mjs': `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
}

export default nextConfig
`,

    'app/layout.tsx': `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: ${tsString(m.name)},
  description: 'Created with cimiento.',
  other: {
    '${MARKER_NAME}': ${tsString(m.slug)},
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,

    'app/page.tsx': `export default function Home() {
  return (
    <main>
      <h1>${jsxText(m.name)}</h1>
      <p>This project was set up by cimiento. Replace this page with your own.</p>
      <p>
        Run <code>cimiento doctor</code> at any time to check that the environment is still healthy.
      </p>
    </main>
  )
}
`,

    'app/globals.css': `:root {
  color-scheme: light dark;
  --fg: #111;
  --bg: #fff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --fg: #f2f2f2;
    --bg: #0b0b0b;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 3rem 1.5rem;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  line-height: 1.6;
  color: var(--fg);
  background: var(--bg);
}

main {
  max-width: 42rem;
  margin: 0 auto;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
}
`,

    ...(usesSupabase
      ? {
          'lib/supabase.ts': `import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('Supabase is not configured. Run cimiento env pull, or cimiento doctor to see what is missing.')
}

export const supabase = createClient(url, anonKey)
`,
          [`supabase/migrations/${BASELINE_FILE}`]: BASELINE_SQL,
        }
      : {}),

    ...(usesInngest ? inngestFiles(m) : {}),
    ...(usesTurnstile ? turnstileFiles() : {}),
    ...(usesAnthropic ? anthropicFiles() : {}),
  }
}

/**
 * The Inngest client, one function and the route Inngest calls. cimiento doctor sends the
 * cimiento/roundtrip event and waits for cimiento-roundtrip to complete, so keep both.
 */
function inngestFiles(m: Manifest): Record<string, string> {
  return {
    'inngest/client.ts': `import { Inngest } from 'inngest'

export const inngest = new Inngest({ id: ${tsString(m.slug)} })
`,
    'inngest/functions.ts': `import { inngest } from './client'

// cimiento doctor sends cimiento/roundtrip and waits for this function to complete. Keep it.
export const roundtrip = inngest.createFunction(
  { id: 'cimiento-roundtrip' },
  { event: 'cimiento/roundtrip' },
  async ({ event }) => ({ nonce: event.data?.nonce ?? null }),
)

export const functions = [roundtrip]
`,
    'app/api/inngest/route.ts': `import { serve } from 'inngest/next'
import { inngest } from '../../../inngest/client'
import { functions } from '../../../inngest/functions'

export const { GET, POST, PUT } = serve({ client: inngest, functions })
`,
  }
}

/** Server side verification of a Turnstile token. The widget itself goes on whichever form needs it. */
function turnstileFiles(): Record<string, string> {
  return {
    'lib/turnstile.ts': `// The page renders the widget with NEXT_PUBLIC_TURNSTILE_SITE_KEY; the server confirms the token
// it produces with TURNSTILE_SECRET_KEY. Both arrive in the env through cimiento.

export async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) throw new Error('Turnstile is not configured. Run cimiento env pull, or cimiento doctor to see what is missing.')
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
  })
  const body = (await res.json()) as { success?: boolean }
  return body.success === true
}
`,
  }
}

/** The Anthropic client. It reads ANTHROPIC_API_KEY from the env, which cimiento keeps filled. */
function anthropicFiles(): Record<string, string> {
  return {
    'lib/anthropic.ts': `import Anthropic from '@anthropic-ai/sdk'

// Reads ANTHROPIC_API_KEY from the environment. Set it with cimiento secret set ANTHROPIC_API_KEY.
export const anthropic = new Anthropic()

export const MODEL = 'claude-opus-5-5'
`,
  }
}
