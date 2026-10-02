import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { Ajv } from 'ajv'
import schema from '../schema.json' with { type: 'json' }

export interface PageMapping {
  /** Markdown path relative to the repository root, posix separators. */
  file: string
  pageId: string
  title?: string
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
  for (const p of pages) {
    if (!existsSync(resolve(repoRoot, p.file))) errors.push(`${p.file}: file not found`)
    if (seenFiles.has(p.file)) errors.push(`${p.file}: mapped more than once`)
    if (seenIds.has(p.pageId)) errors.push(`page ${p.pageId}: mapped from more than one file`)
    seenFiles.add(p.file)
    seenIds.add(p.pageId)
  }
  return errors.length ? { errors } : { config: { baseUrl, pages }, errors }
}
