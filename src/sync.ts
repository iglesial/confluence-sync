import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { XMLValidator } from 'fast-xml-parser'
import { type PageMapping, type SyncConfig, parentsFirst } from './config.ts'
import type { ConfluenceClient } from './confluence.ts'
import { banner, renderPage } from './markdown.ts'

export type PageStatus = 'created' | 'will-create' | 'updated' | 'unchanged' | 'will-update' | 'checked' | 'error'

export interface PageResult {
  file: string
  /** Empty for a page that will be created (check mode) or whose lookup failed. */
  pageId: string
  url: string
  status: PageStatus
  title?: string
  error?: string
  /** Storage XHTML (dry-run / check mode), for logs and the job summary. */
  storage?: string
  uploads?: string[]
  /** Title of the parent the page was (or, in check mode, will be) moved under. */
  movedUnder?: string
  /** Title of the parent the page was (or will be) created under. */
  createdUnder?: string
  /** The mapping had no pageId and an existing page with its title was found under the parent's space. */
  foundByTitle?: boolean
}

export interface SyncOptions {
  config: SyncConfig
  repoRoot: string
  /** owner/repo */
  repo: string
  repoUrl: string
  sha: string
  /** undefined → offline: conversion and local checks only (e.g. fork PRs without secrets). */
  client?: ConfluenceClient
  /** check = never write (pull requests, dry runs). */
  mode: 'publish' | 'check'
  mermaid: 'local' | 'code'
  banner: boolean
  renderMermaid: (source: string) => Promise<Buffer>
  log?: (message: string) => void
}

/** Body of a page just created, until the same run writes its content (an update right after). */
export const CREATED_PLACEHOLDER = '<p>Created by confluence-sync. Its content is published in the same run.</p>'

const pageUrl = (baseUrl: string, id: string) => `${baseUrl}/pages/viewpage.action?pageId=${id}`

/**
 * Syncs every mapped page, in two phases:
 * 1. Pages without a pageId, parents first: found by title in their parent's space,
 *    or created under the parent (publish) / reported as "will create" (check).
 * 2. Every page's content, with all ids known, so links to new pages resolve.
 * Pages are independent: one failure never stops the others; callers fail the run
 * afterwards if any result has status "error".
 */
export async function syncAll(opts: SyncOptions): Promise<PageResult[]> {
  const { config, client, mode } = opts
  const log = opts.log ?? (() => {})
  const idByFile = new Map(config.pages.filter((p) => p.pageId).map((p) => [p.file, p.pageId!]))
  const results = new Map<string, PageResult>(
    config.pages.map((p) => [p.file, { file: p.file, pageId: p.pageId ?? '', url: p.pageId ? pageUrl(config.baseUrl, p.pageId) : '', status: 'error' }]),
  )
  /** Phase 1's outcome for pages without pageId. */
  const pending = new Map<string, { spaceId: string; parentId?: string }>()
  const created = new Set<string>()

  if (client) {
    const spaceByFile = new Map<string, string>()
    for (const page of parentsFirst(config.pages).filter((p) => !p.pageId)) {
      const result = results.get(page.file)!
      result.title = page.title
      try {
        const parentId = page.parentId ?? (page.parentFile ? idByFile.get(page.parentFile) : undefined)
        let spaceId: string | undefined
        if (parentId) {
          const parent = await client.getPage(parentId)
          spaceId = parent.spaceId
          result.createdUnder = parent.title
        } else {
          // The parent is itself a new page. In check mode it isn't created: it tells the space.
          // In publish mode it should exist by now (parents come first), so its creation failed.
          if (mode === 'publish') throw new Error(`${page.file}: its parent ${page.parent} could not be found or created`)
          spaceId = page.parentFile ? spaceByFile.get(page.parentFile) : undefined
          result.createdUnder = config.pages.find((p) => p.file === page.parentFile)?.title
          if (!spaceId) throw new Error(`${page.file}: its parent ${page.parent} could not be resolved`)
        }
        spaceByFile.set(page.file, spaceId)

        const found = await client.findPagesByTitle(spaceId, page.title!)
        if (found.length > 1) {
          throw new Error(`${page.file}: ${found.length} pages are titled "${page.title}" in the parent's space; set its pageId in the mapping`)
        }
        if (found.length === 1) {
          idByFile.set(page.file, found[0].id)
          result.pageId = found[0].id
          result.url = pageUrl(config.baseUrl, found[0].id)
          result.foundByTitle = true
          result.createdUnder = undefined
          continue
        }

        // Validate the page before creating anything, so a broken doc never leaves an empty page behind.
        const problems = render(opts, page, idByFile, page.title).problems
        if (problems.length) throw new Error(problems.join('\n'))
        pending.set(page.file, { spaceId, parentId })
        if (mode === 'check' || !parentId) continue

        const page_ = await client.createPage({ spaceId, parentId, title: page.title!, storage: CREATED_PLACEHOLDER })
        idByFile.set(page.file, page_.id)
        created.add(page.file)
        result.pageId = page_.id
        result.url = pageUrl(config.baseUrl, page_.id)
        log(`${page.file}: created page ${page_.id} under "${result.createdUnder}"`)
      } catch (e) {
        result.error = (e as Error).message
        log(`${page.file}: ${result.error}`)
      }
    }
  }

  for (const page of config.pages) {
    const result = results.get(page.file)!
    if (result.error) continue
    const pageId = idByFile.get(page.file)
    try {
      let live = client && pageId ? await client.getPage(pageId) : undefined
      const title = page.title ?? live?.title
      result.title = title

      const ctx = { file: page.file, repoRoot: opts.repoRoot, pageIdByFile: idByFile, baseUrl: config.baseUrl, repoUrl: opts.repoUrl, sha: opts.sha, title, mermaid: opts.mermaid }
      const rendered = render(opts, page, idByFile, title)
      const problems = [...rendered.problems]

      // Materialize attachments: images from disk, diagrams rendered now (also validates their syntax).
      const files = new Map<string, { data: Buffer; contentType: string }>()
      for (const asset of rendered.assets) {
        try {
          const data = asset.kind === 'file' ? readFileSync(asset.source) : await opts.renderMermaid(asset.source)
          files.set(asset.name, { data, contentType: asset.contentType })
        } catch (e) {
          problems.push(`${page.file}: ${(e as Error).message}`)
        }
      }
      const xml = XMLValidator.validate(`<root>${rendered.storage}</root>`)
      if (xml !== true) problems.push(`${page.file}: generated XHTML is invalid: ${xml.err.msg} (line ${xml.err.line})`)
      if (problems.length) throw new Error(problems.join('\n'))

      // The banner is excluded: it carries the commit sha, which would make every push look like a change.
      const hash = createHash('sha256')
        .update(JSON.stringify({ title, storage: rendered.storage, assets: [...files.keys()].sort() }))
        .digest('hex')

      if (!client) {
        result.status = 'checked'
        result.storage = rendered.storage
        continue
      }
      if (!live) {
        // Check mode, a page to create: report its content and everything it will upload.
        result.status = 'will-create'
        result.storage = (opts.banner ? banner(ctx) : '') + rendered.storage
        result.uploads = [...files.keys()]
        continue
      }

      // Page tree: move the page under its mapped parent when it is elsewhere (same space only).
      let moveTo: string | undefined
      const parentId = page.parentId ?? (page.parentFile ? idByFile.get(page.parentFile) : undefined)
      if (parentId && live.parentId !== parentId) {
        const parent = await client.getPage(parentId)
        if (parent.spaceId !== live.spaceId) throw new Error(`${page.file}: parent page ${parentId} ("${parent.title}") is in another space`)
        moveTo = parent.id
        result.movedUnder = parent.title
      }

      const previous = await client.getSyncProperty(live.id)
      const contentChanged = previous?.hash !== hash
      if (!contentChanged && !moveTo) {
        result.status = 'unchanged'
        continue
      }

      const storage = (opts.banner ? banner(ctx) : '') + rendered.storage
      const existing = files.size ? await client.attachmentNames(live.id) : new Set<string>()
      result.uploads = [...files.keys()].filter((name) => !existing.has(name))

      if (mode === 'check') {
        result.status = 'will-update'
        if (contentChanged) result.storage = storage
        else result.uploads = []
        continue
      }
      if (moveTo) {
        await client.movePage(live.id, moveTo)
        log(`${page.file}: moved under "${result.movedUnder}"`)
        // A move can create a page version; re-read it so the content update targets the latest one.
        live = await client.getPage(live.id)
      }
      if (!contentChanged) {
        result.status = 'updated'
        result.uploads = []
        continue
      }
      for (const name of result.uploads) {
        const f = files.get(name)!
        await client.uploadAttachment(live.id, name, f.data, f.contentType)
        log(`${page.file}: uploaded ${name}`)
      }
      await client.updatePage(live.id, {
        title: title ?? live.title,
        storage,
        version: live.version + 1,
        message: `Synced from ${opts.repo}@${opts.sha.slice(0, 7)}`,
      })
      await client.setSyncProperty(live.id, { hash, sha: opts.sha, file: page.file, repo: opts.repo })
      result.status = created.has(page.file) ? 'created' : 'updated'
      log(`${page.file}: updated page ${live.id} to version ${live.version + 1}`)
    } catch (e) {
      result.status = 'error'
      result.error = (e as Error).message
      log(`${page.file}: ${result.error}`)
    }
  }
  return config.pages.map((p) => results.get(p.file)!)
}

function render(opts: SyncOptions, page: PageMapping, idByFile: Map<string, string>, title: string | undefined) {
  const ctx = {
    file: page.file,
    repoRoot: opts.repoRoot,
    pageIdByFile: idByFile,
    baseUrl: opts.config.baseUrl,
    repoUrl: opts.repoUrl,
    sha: opts.sha,
    title,
    mermaid: opts.mermaid,
  }
  return renderPage(readFileSync(resolve(opts.repoRoot, page.file), 'utf8'), ctx)
}

const ICONS: Record<PageStatus, string> = {
  created: '🆕 created',
  'will-create': '🆕 will create on merge',
  updated: '✅ updated',
  unchanged: '⚪ unchanged',
  'will-update': '🔄 will update on merge',
  checked: '☑️ checked (offline)',
  error: '❌ error',
}

/** Markdown table for the job summary and the PR comment. */
export function resultsTable(results: PageResult[]): string {
  const rows = results.map((r) => {
    const notes = [
      ...(r.foundByTitle ? ['existing page found by title'] : []),
      ...(r.createdUnder ? [`${r.status === 'will-create' ? 'will create' : 'created'} under "${r.createdUnder}"`] : []),
      ...(r.movedUnder ? [`${r.status === 'will-update' ? 'will move' : 'moved'} under "${r.movedUnder}"`] : []),
      ...(r.uploads?.length ? [`attachments: ${r.uploads.join(', ')}`] : []),
    ]
    const detail = r.error ? r.error.replaceAll('\n', '<br>').replaceAll('|', '\\|') : notes.join('; ')
    const name = r.title ?? (r.pageId || r.file)
    const page = r.status === 'will-create' || !r.url ? name : `[${name}](${r.url})`
    return `| \`${r.file}\` | ${page} | ${ICONS[r.status]} | ${detail} |`
  })
  return ['| File | Confluence page | Status | Details |', '|---|---|---|---|', ...rows].join('\n')
}
