import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'
type Token = ReturnType<typeof md.parse>[number]
import { normalizePath } from './config.ts'

export interface RenderContext {
  /** Markdown path relative to the repo root (posix). */
  file: string
  repoRoot: string
  /** Mapped Markdown files → Confluence page ids, for cross-links. */
  pageIdByFile: Map<string, string>
  baseUrl: string
  /** e.g. https://github.com/owner/repo, for links to unmapped repo files. */
  repoUrl: string
  sha: string
  /** Page title; a leading H1 with the same text is dropped. */
  title?: string
  mermaid: 'local' | 'code'
}

/** A file the page needs as a Confluence attachment. */
export interface Asset {
  name: string
  kind: 'file' | 'mermaid'
  /** Absolute path (file) or diagram source (mermaid). */
  source: string
  contentType: string
}

export interface Rendered {
  /** Confluence storage format (XHTML), without the banner. */
  storage: string
  assets: Asset[]
  /** Broken images/links etc.; any problem fails the page. */
  problems: string[]
}

const sha8 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex').slice(0, 8)

const CALLOUTS: Record<string, string> = { NOTE: 'info', TIP: 'tip', IMPORTANT: 'info', WARNING: 'note', CAUTION: 'warning' }
const LANGUAGES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', yml: 'yaml', tf: 'hcl', 'c#': 'csharp', cs: 'csharp', ps1: 'powershell',
}
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
}

const md = new MarkdownIt({ html: false, xhtmlOut: true, linkify: true })
const esc = md.utils.escapeHtml

/** `]]>` cannot appear inside CDATA: split it across two sections. */
const cdata = (text: string) => `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`

export function codeMacro(code: string, lang?: string): string {
  const language = lang ? (LANGUAGES[lang.toLowerCase()] ?? lang.toLowerCase()) : ''
  return (
    '<ac:structured-macro ac:name="code">' +
    (language ? `<ac:parameter ac:name="language">${esc(language)}</ac:parameter>` : '') +
    `<ac:plain-text-body>${cdata(code.replace(/\n$/, ''))}</ac:plain-text-body></ac:structured-macro>\n`
  )
}

export const panelMacro = (name: string, innerXhtml: string) =>
  `<ac:structured-macro ac:name="${name}"><ac:rich-text-body>${innerXhtml}</ac:rich-text-body></ac:structured-macro>\n`

interface Env {
  [key: string | symbol]: unknown
  ctx: RenderContext
  assets: Map<string, Asset>
  problems: string[]
  calloutStack: boolean[]
  taskId: number
}

// GitHub alerts: `> [!NOTE]` as the first line of a blockquote. Runs before inline parsing.
md.core.ruler.after('block', 'callouts', (state) => {
  const t = state.tokens
  for (let i = 0; i < t.length; i++) {
    if (t[i].type !== 'blockquote_open' || t[i + 1]?.type !== 'paragraph_open' || t[i + 2]?.type !== 'inline') continue
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(t[i + 2].content)
    if (!m) continue
    t[i].meta = { callout: CALLOUTS[m[1].toUpperCase()] }
    t[i + 2].content = t[i + 2].content.slice(m[0].length)
    if (!t[i + 2].content.trim()) t.splice(i + 1, 3) // marker alone in its paragraph
  }
})

// Task lists: a bullet list whose every item starts with [ ] / [x]. Runs after inline parsing.
md.core.ruler.after('inline', 'tasklists', (state) => {
  const t = state.tokens
  for (let i = 0; i < t.length; i++) {
    if (t[i].type !== 'bullet_list_open') continue
    const items: { open: Token; text: Token }[] = []
    let depth = 0
    let j = i
    for (; j < t.length; j++) {
      if (t[j].type === 'bullet_list_open' || t[j].type === 'ordered_list_open') depth++
      if (t[j].type === 'bullet_list_close' || t[j].type === 'ordered_list_close') depth--
      if (depth === 0) break
      if (depth === 1 && t[j].type === 'list_item_open') {
        const inline = t[j + 2]?.type === 'inline' ? t[j + 2] : undefined
        const text = inline?.children?.[0]
        if (!text || text.type !== 'text' || !/^\[[ xX]\]\s/.test(text.content)) {
          items.length = 0
          break
        }
        items.push({ open: t[j], text })
      }
    }
    if (!items.length) continue
    t[i].meta = { tasks: true }
    t[j].meta = { tasks: true }
    for (const { open, text } of items) {
      open.meta = { done: /^\[[xX]\]/.test(text.content) }
      text.content = text.content.replace(/^\[[ xX]\]\s+/, '')
    }
  }
})

const rules = md.renderer.rules
const env = (e: unknown) => e as Env

rules.fence = (tokens, idx, _o, e) => {
  const { info, content } = tokens[idx]
  const lang = info.trim().split(/\s+/)[0]
  const { ctx, assets } = env(e)
  if (lang === 'mermaid' && ctx.mermaid === 'local') {
    const name = `mermaid-${sha8(content)}.png`
    assets.set(name, { name, kind: 'mermaid', source: content, contentType: 'image/png' })
    return `<p><ac:image ac:alt="diagram"><ri:attachment ri:filename="${name}" /></ac:image></p>\n`
  }
  return codeMacro(content, lang)
}
rules.code_block = (tokens, idx) => codeMacro(tokens[idx].content)

rules.blockquote_open = (tokens, idx, _o, e) => {
  const callout = tokens[idx].meta?.callout as string | undefined
  env(e).calloutStack.push(!!callout)
  return callout ? `<ac:structured-macro ac:name="${callout}"><ac:rich-text-body>` : '<blockquote>'
}
rules.blockquote_close = (_t, _i, _o, e) =>
  env(e).calloutStack.pop() ? '</ac:rich-text-body></ac:structured-macro>\n' : '</blockquote>\n'

rules.bullet_list_open = (tokens, idx, o, _e, self) =>
  tokens[idx].meta?.tasks ? '<ac:task-list>\n' : self.renderToken(tokens, idx, o)
rules.bullet_list_close = (tokens, idx, o, _e, self) =>
  tokens[idx].meta?.tasks ? '</ac:task-list>\n' : self.renderToken(tokens, idx, o)
rules.list_item_open = (tokens, idx, o, e, self) => {
  const meta = tokens[idx].meta as { done?: boolean } | null
  if (meta?.done === undefined) return self.renderToken(tokens, idx, o)
  return `<ac:task><ac:task-id>${++env(e).taskId}</ac:task-id><ac:task-status>${meta.done ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>`
}
rules.list_item_close = (tokens, idx, o, _e, self) => {
  // The matching open is the nearest preceding list_item_open at the same level.
  let depth = 0
  for (let i = idx; i >= 0; i--) {
    if (tokens[i].type === 'list_item_close') depth++
    if (tokens[i].type === 'list_item_open' && --depth === 0) {
      return (tokens[i].meta as { done?: boolean } | null)?.done === undefined ? self.renderToken(tokens, idx, o) : '</ac:task-body></ac:task>\n'
    }
  }
  return self.renderToken(tokens, idx, o)
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')

rules.image = (tokens, idx, _o, e) => {
  const token = tokens[idx]
  const src = String(token.attrGet('src') ?? '')
  const alt = token.content
  const { ctx, assets, problems } = env(e)
  if (isExternal(src)) return `<ac:image ac:alt="${esc(alt)}"><ri:url ri:value="${esc(src)}" /></ac:image>`
  const rel = normalizePath(posix.join(posix.dirname(ctx.file), decodeURI(src.split(/[?#]/)[0])))
  const abs = resolve(ctx.repoRoot, rel)
  if (!existsSync(abs)) {
    problems.push(`${ctx.file}: image not found: ${src}`)
    return esc(alt)
  }
  const base = posix.basename(rel)
  const name = `${sha8(readFileSync(abs))}-${base}`
  const ext = posix.extname(base).toLowerCase()
  assets.set(name, { name, kind: 'file', source: abs, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' })
  return `<ac:image ac:alt="${esc(alt)}"><ri:attachment ri:filename="${esc(name)}" /></ac:image>`
}

rules.link_open = (tokens, idx, o, e, self) => {
  const token = tokens[idx]
  const href = String(token.attrGet('href') ?? '')
  if (!href.startsWith('#') && !isExternal(href)) {
    const { ctx, problems } = env(e)
    const [pathPart] = href.split('#')
    const rel = normalizePath(pathPart.startsWith('/') ? pathPart.slice(1) : posix.join(posix.dirname(ctx.file), decodeURI(pathPart)))
    const pageId = ctx.pageIdByFile.get(rel)
    if (pageId) token.attrSet('href', `${ctx.baseUrl}/pages/viewpage.action?pageId=${pageId}`)
    // HEAD (default branch), not the commit: a sha in the body would make every push look like a content change.
    else if (existsSync(resolve(ctx.repoRoot, rel))) token.attrSet('href', `${ctx.repoUrl}/blob/HEAD/${rel}`)
    else problems.push(`${ctx.file}: broken link: ${href}`)
  }
  return self.renderToken(tokens, idx, o)
}

/** Converts one Markdown file to Confluence storage format. */
export function renderPage(markdown: string, ctx: RenderContext): Rendered {
  const { content } = matter(markdown)
  const e: Env = { ctx, assets: new Map(), problems: [], calloutStack: [], taskId: 0 }
  const tokens = md.parse(content, e)
  // Drop a leading H1 that repeats the page title.
  if (ctx.title && tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1' && tokens[1]?.content.trim() === ctx.title.trim()) {
    tokens.splice(0, 3)
  }
  const storage = md.renderer.render(tokens, md.options, e)
  return { storage, assets: [...e.assets.values()], problems: e.problems }
}

/** Info panel telling readers the page is generated and where to edit it. */
export function banner(ctx: Pick<RenderContext, 'repoUrl' | 'sha' | 'file'>): string {
  const repo = ctx.repoUrl.replace(/^https?:\/\/[^/]+\//, '')
  const url = `${ctx.repoUrl}/blob/${ctx.sha}/${ctx.file}`
  return panelMacro(
    'info',
    `<p>Generated from <a href="${esc(url)}">${esc(repo)}/${esc(ctx.file)}</a> (commit <code>${esc(ctx.sha.slice(0, 7))}</code>). ` +
      'Edits made here will be overwritten. Change the file in GitHub instead.</p>',
  )
}
