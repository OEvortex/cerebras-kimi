import { describe, expect, it } from 'vitest'
import { safeNoteUrl } from '@/features/notes/model/urls'

describe('safeNoteUrl', () => {
  it('accepts safe absolute, root-relative, fragment and relative links', () => {
    for (const value of [
      'https://x.test',
      'http://x.test',
      'mailto:a@b.c',
      '/co-writer/abc',
      '#top',
      'Lasers',
      'Optical Fibers',
      'a/b',
    ]) {
      expect(safeNoteUrl(value)).toBe(value)
    }
  })

  it('rejects executable schemes, protocol-relative URLs and control chars', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '//evil.test/x',
      'java\nscript:alert(1)',
      '',
    ]) {
      expect(safeNoteUrl(value)).toBeNull()
    }
  })
})
