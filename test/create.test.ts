import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, normalizePath, parentsFirst } from '../src/config.ts'
import type { ConfluenceClient, PageInfo, SyncProperty } from '../src/confluence.ts'
import { pinPageIds, pinPrBody } from '../src/github.ts'
import { type SyncOptions, resultsTable, syncAll } from '../src/sync.ts'

const repoRoot = resolve(__dirname, 'fixtures')
const bad = resolve(__dirname, 'fixtures/bad')
const config = loadConfig('docs/confluence-create.json', repoRoot).config!

type FakePage = { title: string; version: number; spaceId?: string; parentId?: string }

/** In-memory Confluence: placeholder spaces, ids and titles only. */
function fakeConfluence(pages: Record<string, FakePage>) {
  const calls: string[] = []
  const properties = new Map<string, SyncProperty>()
  const info = (id: string): PageInfo => ({ id, spaceId: 'S1', ...pages[id] })
  const client: ConfluenceClient = {
    async getPage(id) {
      calls.push(`get ${id}`)
      if (!pages[id]) throw new Error(`GET /api/v2/pages/${id} → 404`)
      return info(id)
    },
    async attachmentNames() {
      return new Set()
    },
    async uploadAttachment(id, name) {
      calls.push(`upload ${id} ${name}`)
    },
    async getSyncProperty(id) {
      return properties.get(id) ?? null
    },
    async setSyncProperty(id, value) {
      properties.set(id, value)
    },
    async movePage(id, parentId) {
      calls.push(`move ${id} under ${parentId}`)
      pages[id].parentId = parentId
    },
    async updatePage(id, page) {
      calls.push(`update ${id} v${page.version}`)
      pages[id].version = page.version
      pages[id].title = page.title
    },
    async findPagesByTitle(spaceId, title) {
      calls.push(`find "${title}"`)
      return Object.keys(pages)
        .filter((id) => (pages[id].spaceId ?? 'S1') === spaceId && pages[id].title === title)
        .map(info)
    },
    async createPage({ spaceId, parentId, title }) {
      const id = String(5000 + Object.keys(pages).length)
      calls.push(`create ${id} "${title}" under ${parentId}`)
      pages[id] = { title, version: 1, spaceId, parentId }
      return info(id)
    },
  }
  return { client, calls, pages }
}

const options = (over: Partial<SyncOptions>): SyncOptions => ({
  config,
  repoRoot,
  repo: 'o/r',
  repoUrl: 'https://github.com/o/r',
  sha: 'abcdef1234567',
  mode: 'publish',
  mermaid: 'code',
  banner: true,
  renderMermaid: async () => Buffer.from('png'),
  ...over,
})

const existing = () => ({ '1002': { title: 'Other page', version: 1 } })

describe('mapping entries without pageId', () => {
  it('loads them, resolving a parent that is itself new, and orders parents first', () => {
    const [other, child, section] = config.pages
    expect(child).toMatchObject({ file: 'docs/new/child.md', parentFile: 'docs/new/section.md', parentId: undefined })
    expect(section).toMatchObject({ parentFile: 'docs/other.md', parentId: '1002' })
    expect(other.pageId).toBe('1002')
    expect(parentsFirst(config.pages).map((p) => p.file)).toEqual(['docs/other.md', 'docs/new/section.md', 'docs/new/child.md'])
  })

  it('needs a title and a parent without pageId', () => {
    const { errors } = loadConfig('docs/create-schema.json', bad)
    expect(errors.join('\n')).toMatch(/must have required property 'parent'/)
  })

  it('rejects two new pages with the same title, and cycles between new pages', () => {
    const { errors } = loadConfig('docs/create-errors.json', bad)
    expect(errors).toContain('docs/b.md: another page without pageId has the title "same TITLE"')
    expect(errors).toContain('docs/c.md: parent chain loops back to this page')
    expect(errors).toContain('docs/d.md: parent chain loops back to this page')
  })
})

describe('syncAll with pages to create', () => {
  it('creates a new parent and a new child in one run, parents first, then publishes them', async () => {
    const { client, calls, pages } = fakeConfluence(existing())
    const results = await syncAll(options({ client }))
    expect(results.map((r) => [r.file, r.status, r.pageId])).toEqual([
      ['docs/other.md', 'updated', '1002'],
      ['docs/new/child.md', 'created', '5002'],
      ['docs/new/section.md', 'created', '5001'],
    ])
    expect(calls.filter((c) => c.startsWith('create') || c.startsWith('find'))).toEqual([
      'find "New section"',
      'create 5001 "New section" under 1002',
      'find "New child"',
      'create 5002 "New child" under 5001',
    ])
    expect(pages['5002'].parentId).toBe('5001')
    // The content update comes after the creation, in the same run.
    expect(calls.indexOf('update 5001 v2')).toBeGreaterThan(calls.indexOf('create 5001 "New section" under 1002'))
    expect(results[1].createdUnder).toBe('New section')
    expect(resultsTable(results)).toContain('🆕 created | created under "New section"')
  })

  it('links a page to a page created in the same run', async () => {
    const { client } = fakeConfluence(existing())
    const storageOf: Record<string, string> = {}
    const recording: ConfluenceClient = {
      ...client,
      async updatePage(id, page) {
        storageOf[id] = page.storage
        return client.updatePage(id, page)
      },
    }
    await syncAll(options({ client: recording }))
    expect(storageOf['5002']).toContain('pages/viewpage.action?pageId=5001')
    expect(storageOf['5002']).toContain('pages/viewpage.action?pageId=1002')
  })

  it('is idempotent: a re-run finds the created pages by title and changes nothing', async () => {
    const { client, calls } = fakeConfluence(existing())
    await syncAll(options({ client }))
    calls.length = 0
    const again = await syncAll(options({ client, sha: '9999999aaaaaaa' }))
    expect(again.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    expect(again.slice(1).every((r) => r.foundByTitle)).toBe(true)
    expect(calls.some((c) => c.startsWith('create') || c.startsWith('update') || c.startsWith('move'))).toBe(false)
  })

  it('uses an existing page with the same title, and moves it under the mapped parent', async () => {
    const { client, calls } = fakeConfluence({ ...existing(), '3000': { title: 'New section', version: 4, parentId: '777' } })
    const results = await syncAll(options({ client }))
    expect(results[2]).toMatchObject({ pageId: '3000', status: 'updated', foundByTitle: true, movedUnder: 'Other page' })
    expect(calls).toContain('move 3000 under 1002')
    expect(calls.some((c) => c.startsWith('create') && c.includes('"New section"'))).toBe(false)
    // The child is created under the page that was found.
    expect(calls.some((c) => /^create \d+ "New child" under 3000$/.test(c))).toBe(true)
  })

  it('refuses an ambiguous title, and the child of a page that could not be resolved', async () => {
    const { client, calls } = fakeConfluence({
      ...existing(),
      '3000': { title: 'New section', version: 1 },
      '3001': { title: 'New section', version: 1 },
    })
    const results = await syncAll(options({ client }))
    expect(results[2].status).toBe('error')
    expect(results[2].error).toMatch(/2 pages are titled "New section"/)
    expect(results[1].status).toBe('error')
    expect(results[1].error).toMatch(/its parent docs\/new\/section.md could not be found or created/)
    expect(results[0].status).toBe('updated')
    expect(calls.some((c) => c.startsWith('create'))).toBe(false)
  })

  it('writes nothing in check mode, and says what it will create and where', async () => {
    const { client, calls } = fakeConfluence(existing())
    const results = await syncAll(options({ client, mode: 'check' }))
    expect(results.map((r) => r.status)).toEqual(['will-update', 'will-create', 'will-create'])
    expect(results[2]).toMatchObject({ pageId: '', url: '', createdUnder: 'Other page' })
    expect(results[1]).toMatchObject({ createdUnder: 'New section' })
    expect(results[1].storage).toContain('Generated from')
    expect(calls.every((c) => c.startsWith('get') || c.startsWith('find'))).toBe(true)
    const table = resultsTable(results)
    expect(table).toContain('| `docs/new/section.md` | New section | 🆕 will create on merge | will create under "Other page" |')
    expect(table).toContain('will create under "New section"')
  })

  it('checks pages without pageId offline', async () => {
    const results = await syncAll(options({ client: undefined, mode: 'check' }))
    expect(results.map((r) => r.status)).toEqual(['checked', 'checked', 'checked'])
  })
})

describe('pinning the ids', () => {
  const pins = [
    { file: 'docs/new/section.md', pageId: '5001', title: 'New section', status: 'created' },
    { file: 'docs/new/child.md', pageId: '5002', title: 'New child', status: 'updated' },
  ]

  it('adds pageId after each file, keeping the rest of the text as is', () => {
    const raw = [
      '{',
      '  "baseUrl": "https://example.atlassian.net/wiki",',
      '  "pages": [',
      '    { "file": "docs/other.md", "pageId": "1002" },',
      '    { "file": "./docs/new/child.md", "title": "New child", "parent": "docs/new/section.md" },',
      '    {',
      '      "file": "docs/new/section.md",',
      '      "title": "New section",',
      '      "parent": "docs/other.md"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(pinPageIds(raw, pins, normalizePath)).toBe(
      raw
        .replace('"file": "./docs/new/child.md"', '"file": "./docs/new/child.md", "pageId": "5002"')
        .replace('"file": "docs/new/section.md",', '"file": "docs/new/section.md", "pageId": "5001",'),
    )
  })

  it('describes the pinned pages in the pull request', () => {
    const body = pinPrBody(pins, 'docs/confluence.json')
    expect(body).toContain('| `docs/new/section.md` | 5001 | New section | created |')
    expect(body).toContain('| `docs/new/child.md` | 5002 | New child | found by title |')
  })
})
