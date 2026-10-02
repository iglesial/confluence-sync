import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const good = resolve(__dirname, 'fixtures')
const bad = resolve(__dirname, 'fixtures/bad')

describe('loadConfig', () => {
  it('loads a valid mapping and normalizes it', () => {
    const { config, errors } = loadConfig('docs/confluence.json', good)
    expect(errors).toEqual([])
    expect(config?.baseUrl).toBe('https://example.atlassian.net/wiki')
    expect(config?.pages.map((p) => p.file)).toEqual(['docs/guide/all-features.md', 'docs/other.md'])
  })

  it('lets the base-url input override the file, without trailing slash', () => {
    expect(loadConfig('docs/confluence.json', good, 'https://other.example/wiki/').config?.baseUrl).toBe('https://other.example/wiki')
  })

  it('reports every mapping problem at once', () => {
    const { config, errors } = loadConfig('docs/confluence.json', bad)
    expect(config).toBeUndefined()
    expect(errors).toEqual([
      'docs/missing.md: file not found',
      'page 1: mapped from more than one file',
      'docs/broken.md: mapped more than once',
    ])
  })

  it('reports schema errors', () => {
    const { errors } = loadConfig('docs/invalid.json', bad)
    expect(errors.join('\n')).toMatch(/must NOT have additional properties/)
    expect(errors.join('\n')).toMatch(/pages\/0\/file: must match pattern/)
    expect(errors.join('\n')).toMatch(/pages\/0\/pageId: must match pattern/)
  })

  it('reports a missing mapping file', () => {
    expect(loadConfig('docs/nope.json', good).errors).toEqual(['Mapping file docs/nope.json not found'])
  })

  describe('parent', () => {
    const write = (pages: object[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'cs-parent-'))
      mkdirSync(join(dir, 'docs'))
      for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(dir, 'docs', f), '# x')
      writeFileSync(join(dir, 'docs/confluence.json'), JSON.stringify({ baseUrl: 'https://x/wiki', pages }))
      return loadConfig('docs/confluence.json', dir)
    }

    it('resolves a mapped file or a page id to parentId', () => {
      const { config, errors } = write([
        { file: 'docs/a.md', pageId: '1' },
        { file: 'docs/b.md', pageId: '2', parent: './docs/a.md' },
        { file: 'docs/c.md', pageId: '3', parent: '42' },
      ])
      expect(errors).toEqual([])
      expect(config?.pages.map((p) => p.parentId)).toEqual([undefined, '1', '42'])
    })

    it('rejects unmapped parents, self-parents and cycles', () => {
      expect(write([{ file: 'docs/a.md', pageId: '1', parent: 'docs/zzz.md' }]).errors).toEqual([
        'docs/a.md: parent docs/zzz.md is not a mapped file (map it, or use its page id)',
      ])
      expect(write([{ file: 'docs/a.md', pageId: '1', parent: '1' }]).errors).toEqual(['docs/a.md: a page cannot be its own parent'])
      expect(
        write([
          { file: 'docs/a.md', pageId: '1', parent: 'docs/b.md' },
          { file: 'docs/b.md', pageId: '2', parent: 'docs/a.md' },
        ]).errors,
      ).toEqual(['docs/a.md: parent chain loops back to this page', 'docs/b.md: parent chain loops back to this page'])
    })

    it('rejects a parent that is neither a page id nor a .md file', () => {
      expect(write([{ file: 'docs/a.md', pageId: '1', parent: 'docs/a.txt' }]).errors.join()).toMatch(/parent: must match pattern/)
    })
  })
})
