import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { ConfluenceError, type ConfluenceClient, type SyncProperty } from '../src/confluence.ts'
import { type SyncOptions, resultsTable, syncAll } from '../src/sync.ts'

const repoRoot = resolve(__dirname, 'fixtures')
const config = loadConfig('docs/confluence.json', repoRoot).config!
const fakePng = Buffer.from('png')

/** In-memory Confluence with call recording. */
function fakeConfluence(pages: Record<string, { title: string; version: number; spaceId?: string; parentId?: string }>) {
  const calls: string[] = []
  const properties = new Map<string, SyncProperty>()
  const attachments = new Map<string, Set<string>>()
  const client: ConfluenceClient = {
    async getPage(id) {
      calls.push(`get ${id}`)
      const p = pages[id]
      if (!p) throw new ConfluenceError(`GET /api/v2/pages/${id} → 404 (wrong page id, or the token cannot see this page)`, 404)
      return { id, spaceId: 'S1', ...p }
    },
    async attachmentNames(id) {
      return attachments.get(id) ?? new Set()
    },
    async uploadAttachment(id, name) {
      calls.push(`upload ${id} ${name.replace(/^[0-9a-f]{8}-|-[0-9a-f]{8}/, '')}`)
      attachments.set(id, (attachments.get(id) ?? new Set()).add(name))
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
      calls.push(`update ${id} v${page.version} "${page.title}" ${page.message}`)
      pages[id].version = page.version
    },
  }
  return { client, calls }
}

const options = (over: Partial<SyncOptions>): SyncOptions => ({
  config,
  repoRoot,
  repo: 'o/r',
  repoUrl: 'https://github.com/o/r',
  sha: 'abcdef1234567',
  mode: 'publish',
  mermaid: 'local',
  banner: true,
  renderMermaid: async () => fakePng,
  ...over,
})

describe('syncAll', () => {
  it('publishes pages with attachments, then skips them when nothing changed', async () => {
    const { client, calls } = fakeConfluence({ '1001': { title: 'Old title', version: 3 }, '1002': { title: 'Other page', version: 7 } })
    const first = await syncAll(options({ client }))
    expect(first.map((r) => r.status)).toEqual(['updated', 'updated'])
    expect(calls).toEqual([
      'get 1001',
      'upload 1001 mermaid.png',
      'upload 1001 logo.png',
      'update 1001 v4 "All features" Synced from o/r@abcdef1',
      'get 1002',
      'update 1002 v8 "Other page" Synced from o/r@abcdef1',
    ])

    calls.length = 0
    // A new commit with identical content must not create page versions (the banner's sha is not hashed).
    const second = await syncAll(options({ client, sha: '9999999aaaaaaa' }))
    expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged'])
    expect(calls).toEqual(['get 1001', 'get 1002'])
  })

  it('never writes in check mode and reports what would change', async () => {
    const { client, calls } = fakeConfluence({ '1001': { title: 'T', version: 1 }, '1002': { title: 'O', version: 1 } })
    const results = await syncAll(options({ client, mode: 'check' }))
    expect(results.map((r) => r.status)).toEqual(['will-update', 'will-update'])
    expect(results[0].uploads?.length).toBe(2)
    expect(results[0].storage).toContain('Generated from')
    expect(calls.every((c) => c.startsWith('get'))).toBe(true)
  })

  it('runs offline checks without a client', async () => {
    const results = await syncAll(options({ client: undefined, mode: 'check' }))
    expect(results.map((r) => r.status)).toEqual(['checked', 'checked'])
  })

  it('isolates failures: a bad page id or a broken diagram fails only that page', async () => {
    const { client } = fakeConfluence({ '1002': { title: 'Other page', version: 1 } })
    const results = await syncAll(options({ client }))
    expect(results[0].status).toBe('error')
    expect(results[0].error).toMatch(/404 \(wrong page id/)
    expect(results[1].status).toBe('updated')

    const broken = await syncAll(
      options({
        client: undefined,
        mode: 'check',
        renderMermaid: async () => {
          throw new Error('Mermaid diagram failed to render:\nParse error on line 1')
        },
      }),
    )
    expect(broken[0].status).toBe('error')
    expect(broken[0].error).toMatch(/Parse error on line 1/)
    expect(broken[1].status).toBe('checked')
  })

  it('renders a results table with links and errors', () => {
    const table = resultsTable([
      { file: 'docs/a.md', pageId: '1', url: 'https://x/1', status: 'updated', title: 'A' },
      { file: 'docs/b.md', pageId: '2', url: 'https://x/2', status: 'error', error: 'line1\nline|2' },
    ])
    expect(table).toContain('| `docs/a.md` | [A](https://x/1) | ✅ updated |')
    expect(table).toContain('line1<br>line\\|2')
  })

  describe('page tree (parent)', () => {
    const treeConfig = {
      ...config,
      pages: [
        { ...config.pages[1], parentId: undefined }, // docs/other.md → 1002, the parent
        { ...config.pages[0], parent: 'docs/other.md', parentId: '1002' }, // all-features → under 1002
      ],
    }

    it('moves a page under its parent, then leaves it alone', async () => {
      const { client, calls } = fakeConfluence({ '1001': { title: 'All features', version: 1, parentId: '9' }, '1002': { title: 'Other page', version: 1 } })
      const first = await syncAll(options({ client, config: treeConfig }))
      expect(first.map((r) => r.status)).toEqual(['updated', 'updated'])
      expect(first[1].movedUnder).toBe('Other page')
      expect(calls).toContain('move 1001 under 1002')
      // The move happens before the content update, which then uses the re-read version.
      expect(calls.indexOf('move 1001 under 1002')).toBeLessThan(calls.findIndex((c) => c.startsWith('update 1001')))

      calls.length = 0
      const second = await syncAll(options({ client, config: treeConfig }))
      expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged'])
      expect(calls.some((c) => c.startsWith('move'))).toBe(false)
    })

    it('moves a page whose content did not change', async () => {
      const { client, calls } = fakeConfluence({ '1001': { title: 'All features', version: 1 }, '1002': { title: 'Other page', version: 1 } })
      await syncAll(options({ client, config: treeConfig })) // publish content first
      calls.length = 0
      ;(await client.getPage('1001')) && client.movePage('1001', '777') // someone moves it away in Confluence
      calls.length = 0
      const results = await syncAll(options({ client, config: treeConfig }))
      expect(results[1]).toMatchObject({ status: 'updated', movedUnder: 'Other page' })
      expect(calls).toEqual(['get 1002', 'get 1001', 'get 1002', 'move 1001 under 1002', 'get 1001'])
    })

    it('only reports the move in check mode', async () => {
      const { client, calls } = fakeConfluence({ '1001': { title: 'All features', version: 1, parentId: '9' }, '1002': { title: 'Other page', version: 1 } })
      const results = await syncAll(options({ client, config: treeConfig, mode: 'check' }))
      expect(results[1]).toMatchObject({ status: 'will-update', movedUnder: 'Other page' })
      expect(calls.some((c) => c.startsWith('move') || c.startsWith('update'))).toBe(false)
      expect(resultsTable(results)).toContain('will move under "Other page"')
    })

    it('refuses a parent in another space', async () => {
      const { client, calls } = fakeConfluence({ '1001': { title: 'All features', version: 1 }, '1002': { title: 'Other page', version: 1, spaceId: 'S2' } })
      const results = await syncAll(options({ client, config: treeConfig }))
      expect(results[1].status).toBe('error')
      expect(results[1].error).toMatch(/is in another space/)
      expect(calls.some((c) => c.startsWith('move'))).toBe(false)
    })
  })
})
