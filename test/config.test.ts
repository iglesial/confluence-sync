import { resolve } from 'node:path'
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
})
