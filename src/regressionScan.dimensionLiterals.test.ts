// src/regressionScan.dimensionLiterals.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const PATTERNS = [/repeat\(5/, /\btarget:\s*15\b/, /\.length\s*===?\s*15\b/, /Array\(15\)/, /%\s*5\b/, /\/\s*5\b/, /\*\s*5\b/] // not-a-ticket-dimension
// Files/lines allowlisted as unrelated to ticket dimensions (Req 20/24.3's
// literal Cyber Five "5", unrelated %, *, / usage) carry a trailing
// `// not-a-ticket-dimension` comment and are skipped by the scanner.

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (['.ts', '.tsx'].includes(extname(full))) out.push(full)
  }
  return out
}

describe('Requirement 31: no stray 15-cell/5-column literals remain', () => { // not-a-ticket-dimension
  it('reports zero un-allowlisted matches across src/', () => {
    const offenders: string[] = []
    for (const file of walk('src')) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('not-a-ticket-dimension')) return
        if (PATTERNS.some((p) => p.test(line))) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
