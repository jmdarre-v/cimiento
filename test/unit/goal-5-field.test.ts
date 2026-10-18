// Regression tests for the bugs field test 5 found (docs/FIELD-TEST-5.md), from BUG-60 on.

import { describe, expect, it } from 'vitest'
import { scaffoldFiles } from '../../src/scaffold'
import { manifestFor } from './helpers'

describe('BUG-60: files next dev writes stay out of the repository', () => {
  it('the scaffold .gitignore lists next-env.d.ts and *.tsbuildinfo, so cimiento publish never commits them', () => {
    for (const preset of ['designer', 'fullstack'] as const) {
      const gitignore = scaffoldFiles(manifestFor({}, preset))['.gitignore']
      expect(gitignore, preset).toContain('next-env.d.ts')
      expect(gitignore, preset).toContain('*.tsbuildinfo')
    }
  })
})
