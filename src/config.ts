import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { Ajv } from 'ajv'
import schema from '../schema.json' with { type: 'json' }

export interface PageMapping {
  /** Markdown path relative to the repository root, posix separators. */
  file: string
  /** Id of an existing page. Without it the page is found by title under its parent, or created. */
  pageId?: string
  title?: string
  /** As written in the mapping: a mapped .md file or a page id. */
  parent?: string
  /** `parent` as a Confluence page id, when known now (a page id, or a mapped file that has a pageId). */
  parentId?: string
  /** `parent` as a mapped file, normalized. Its id may only be known during the run (a page found or created). */
  parentFile?: string
}

export interface SyncConfig {
  baseUrl: string
  pages: PageMapping[]
}

/** Repo-relative posix path without leading "./". */
export const normalizePath = (p: string) => posix.normalize(p.replaceAll('\\', '/')).replace(/^\.\//, '')

/**
 * Loads and validates the mapping file. Returns every problem found (schema,
 * missing files, duplicates) instead of stopping at the first one, so a PR check
 * can report them all at once.
 */
export function loadConfig(
  configPath: string,
  repoRoot: string,
  baseUrlOverride?: string,
): { config?: SyncConfig; errors: string[] } {
  const abs = resolve(repoRoot, configPath)
  if (!existsSync(abs)) return { errors: [`Mapping file ${configPath} not found`] }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'))
  } catch (e) {
    return { errors: [`${configPath} is not valid JSON: ${(e as Error).message}`] }
  }

  const validate = new Ajv({ allErrors: true }).compile<SyncConfig>(schema)
  if (!validate(raw)) {
    return { errors: (validate.errors ?? []).map((e) => `${configPath}${e.instancePath || ''}: ${e.message}`) }
  }

  const errors: string[] = []
  const baseUrl = (baseUrlOverride || raw.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) errors.push(`No Confluence URL: set "baseUrl" in ${configPath} or the base-url input`)

  const pages = raw.pages.map((p) => ({ ...p, file: normalizePath(p.file) }))
  const seenFiles = new Set<string>()
  const seenIds = new Set<string>()
  const newTitles = new Set<string>()
  for (const p of pages) {
    if (!existsSync(resolve(repoRoot, p.file))) errors.push(`${p.file}: file not found`)
    if (seenFiles.has(p.file)) errors.push(`${p.file}: mapped more than once`)
    if (p.pageId) {
      if (seenIds.has(p.pageId)) errors.push(`page ${p.pageId}: mapped from more than one file`)
      seenIds.add(p.pageId)
    } else {
      // Pages without an id are found by title, and titles are unique within a space.
      const key = p.title!.trim().toLowerCase()
      if (newTitles.has(key)) errors.push(`${p.file}: another page without pageId has the title "${p.title}"`)
      newTitles.add(key)
    }
    seenFiles.add(p.file)
  }
  errors.push(...resolveParents(pages))
  return errors.length ? { errors } : { config: { baseUrl, pages }, errors }
}

/**
 * Fills `parentFile` / `parentId` from `parent` (mapped file or page id) and rejects
 * unknown parents, self-parents and cycles. Links are followed by file, so a parent
 * that has no pageId yet (found or created during the run) works too.
 */
function resolveParents(pages: PageMapping[]): string[] {
  const errors: string[] = []
  const byFile = new Map(pages.map((p) => [p.file, p]))
  const fileById = new Map(pages.filter((p) => p.pageId).map((p) => [p.pageId!, p.file]))
  for (const p of pages) {
    if (!p.parent) continue
    if (/^[0-9]+$/.test(p.parent)) {
      p.parentId = p.parent
      p.parentFile = fileById.get(p.parent)
    } else {
      const parent = byFile.get(normalizePath(p.parent))
      if (!parent) {
        errors.push(`${p.file}: parent ${p.parent} is not a mapped file (map it, or use its page id)`)
        continue
      }
      p.parentFile = parent.file
      p.parentId = parent.pageId
    }
    if (p.parentFile === p.file || (p.pageId && p.parentId === p.pageId)) errors.push(`${p.file}: a page cannot be its own parent`)
  }
  // Follow parent links within the mapping; coming back to the start is a cycle.
  for (const p of pages) {
    const seen = new Set([p.file])
    for (let f = byFile.get(p.file)?.parentFile; f; f = byFile.get(f)?.parentFile) {
      if (seen.has(f)) {
        if (f === p.file && p.parentFile !== p.file) errors.push(`${p.file}: parent chain loops back to this page`)
        break
      }
      seen.add(f)
    }
  }
  return errors
}

/** The pages with every mapped parent before its children; otherwise in mapping order. */
export function parentsFirst(pages: PageMapping[]): PageMapping[] {
  const byFile = new Map(pages.map((p) => [p.file, p]))
  const ordered: PageMapping[] = []
  const placed = new Set<string>()
  const place = (p: PageMapping, path: Set<string>) => {
    if (placed.has(p.file) || path.has(p.file)) return
    path.add(p.file)
    const parent = p.parentFile ? byFile.get(p.parentFile) : undefined
    if (parent) place(parent, path)
    placed.add(p.file)
    ordered.push(p)
  }
  for (const p of pages) place(p, new Set())
  return ordered
}
