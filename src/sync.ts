import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { XMLValidator } from 'fast-xml-parser'
import type { SyncConfig } from './config.ts'
import type { ConfluenceClient } from './confluence.ts'
import { banner, renderPage } from './markdown.ts'

export type PageStatus = 'updated' | 'unchanged' | 'will-update' | 'checked' | 'error'

export interface PageResult {
  file: string
  pageId: string
  url: string
  status: PageStatus
  title?: string
  error?: string
  /** Storage XHTML (dry-run / check mode), for logs and the job summary. */
  storage?: string
  uploads?: string[]
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

/**
 * Syncs every mapped page. Pages are independent: one failure never stops the
 * others; callers fail the run afterwards if any result has status "error".
 */
export async function syncAll(opts: SyncOptions): Promise<PageResult[]> {
  const { config, client, mode } = opts
  const log = opts.log ?? (() => {})
  const pageIdByFile = new Map(config.pages.map((p) => [p.file, p.pageId]))
  const results: PageResult[] = []

  for (const page of config.pages) {
    const result: PageResult = {
      file: page.file,
      pageId: page.pageId,
      url: `${config.baseUrl}/pages/viewpage.action?pageId=${page.pageId}`,
      status: 'error',
    }
    results.push(result)
    try {
      const live = client ? await client.getPage(page.pageId) : undefined
      const title = page.title ?? live?.title
      result.title = title

      const ctx = { file: page.file, repoRoot: opts.repoRoot, pageIdByFile, baseUrl: config.baseUrl, repoUrl: opts.repoUrl, sha: opts.sha, title, mermaid: opts.mermaid }
      const rendered = renderPage(readFileSync(resolve(opts.repoRoot, page.file), 'utf8'), ctx)
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

      if (!client || !live) {
        result.status = 'checked'
        result.storage = rendered.storage
        continue
      }
      const previous = await client.getSyncProperty(page.pageId)
      if (previous?.hash === hash) {
        result.status = 'unchanged'
        continue
      }

      const storage = (opts.banner ? banner(ctx) : '') + rendered.storage
      const existing = files.size ? await client.attachmentNames(page.pageId) : new Set<string>()
      result.uploads = [...files.keys()].filter((name) => !existing.has(name))

      if (mode === 'check') {
        result.status = 'will-update'
        result.storage = storage
        continue
      }
      for (const name of result.uploads) {
        const f = files.get(name)!
        await client.uploadAttachment(page.pageId, name, f.data, f.contentType)
        log(`${page.file}: uploaded ${name}`)
      }
      await client.updatePage(page.pageId, {
        title: title ?? live.title,
        storage,
        version: live.version + 1,
        message: `Synced from ${opts.repo}@${opts.sha.slice(0, 7)}`,
      })
      await client.setSyncProperty(page.pageId, { hash, sha: opts.sha, file: page.file, repo: opts.repo })
      result.status = 'updated'
      log(`${page.file}: updated page ${page.pageId} to version ${live.version + 1}`)
    } catch (e) {
      result.status = 'error'
      result.error = (e as Error).message
      log(`${page.file}: ${result.error}`)
    }
  }
  return results
}

const ICONS: Record<PageStatus, string> = {
  updated: '✅ updated',
  unchanged: '⚪ unchanged',
  'will-update': '🔄 will update on merge',
  checked: '☑️ checked (offline)',
  error: '❌ error',
}

/** Markdown table for the job summary and the PR comment. */
export function resultsTable(results: PageResult[]): string {
  const rows = results.map((r) => {
    const detail = r.error ? r.error.replaceAll('\n', '<br>').replaceAll('|', '\\|') : r.uploads?.length ? `attachments: ${r.uploads.join(', ')}` : ''
    return `| \`${r.file}\` | [${r.title ?? r.pageId}](${r.url}) | ${ICONS[r.status]} | ${detail} |`
  })
  return ['| File | Confluence page | Status | Details |', '|---|---|---|---|', ...rows].join('\n')
}
