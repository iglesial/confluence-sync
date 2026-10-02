import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { banner, codeMacro, renderPage, type RenderContext } from '../src/markdown.ts'

const repoRoot = resolve(__dirname, 'fixtures')
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  file: 'docs/guide/all-features.md',
  repoRoot,
  pageIdByFile: new Map([
    ['docs/guide/all-features.md', '1001'],
    ['docs/other.md', '1002'],
  ]),
  baseUrl: 'https://example.atlassian.net/wiki',
  repoUrl: 'https://github.com/o/r',
  sha: 'abcdef1234567',
  title: 'All features',
  mermaid: 'local',
  ...over,
})
const render = (markdown: string, over: Partial<RenderContext> = {}) => renderPage(markdown, ctx(over))
const allFeatures = readFileSync(resolve(repoRoot, 'docs/guide/all-features.md'), 'utf8')
const wellFormed = (xhtml: string) => XMLValidator.validate(`<root>${xhtml}</root>`)

describe('renderPage', () => {
  it('converts every supported feature (snapshot)', () => {
    const r = render(allFeatures)
    expect(r.problems).toEqual([])
    expect(r.storage).toMatchSnapshot()
    expect(r.assets.map((a) => [a.kind, a.name])).toEqual([
      ['mermaid', expect.stringMatching(/^mermaid-[0-9a-f]{8}\.png$/)],
      ['file', expect.stringMatching(/^[0-9a-f]{8}-logo\.png$/)],
    ])
  })

  it('always produces well-formed XHTML', () => {
    expect(wellFormed(render(allFeatures).storage)).toBe(true)
    expect(wellFormed(render('a <b> & c\n\n<div>raw</div>\n\nline  \nbreak').storage)).toBe(true)
  })

  it('escapes raw HTML instead of passing it through', () => {
    expect(render('<script>alert(1)</script>').storage).toContain('&lt;script&gt;')
  })

  it('keeps ]]> intact inside code blocks', () => {
    const out = codeMacro('a ]]> b', 'ts')
    expect(wellFormed(out)).toBe(true)
    expect(out).toContain('<![CDATA[a ]]]]><![CDATA[> b]]>')
    expect(out).toContain('<ac:parameter ac:name="language">typescript</ac:parameter>')
  })

  it('maps callouts to panels and leaves plain quotes alone', () => {
    const out = render('> [!CAUTION]\n> Danger\n\n> [!TIP]\n> Hint\n\n> just a quote').storage
    expect(out).toContain('<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Danger</p>')
    expect(out).toContain('<ac:structured-macro ac:name="tip">')
    expect(out).toContain('<blockquote><p>just a quote</p>')
  })

  it('rewrites links: mapped docs → Confluence, repo files → GitHub (HEAD), broken → problem', () => {
    const r = render('[a](../other.md#x) [b](../confluence.json) [c](https://x.y) [d](#top) [e](./gone.md)')
    expect(r.storage).toContain('href="https://example.atlassian.net/wiki/pages/viewpage.action?pageId=1002"')
    expect(r.storage).toContain('href="https://github.com/o/r/blob/HEAD/docs/confluence.json"')
    expect(r.storage).toContain('href="https://x.y"')
    expect(r.storage).toContain('href="#top"')
    expect(r.problems).toEqual(['docs/guide/all-features.md: broken link: ./gone.md'])
  })

  it('reports missing images and keeps their alt text', () => {
    const r = render('![Missing](./nope.png)')
    expect(r.problems).toEqual(['docs/guide/all-features.md: image not found: ./nope.png'])
    expect(r.storage).toContain('Missing')
    expect(r.assets).toEqual([])
  })

  it('leaves mermaid as a code block when mermaid is "code"', () => {
    const r = render('```mermaid\ngraph TD; A-->B\n```', { mermaid: 'code' })
    expect(r.assets).toEqual([])
    expect(r.storage).toContain('<ac:parameter ac:name="language">mermaid</ac:parameter>')
  })

  it('drops a leading H1 only when it repeats the title', () => {
    expect(render('# All features\n\nx').storage).not.toContain('<h1>')
    expect(render('# Something else\n\nx').storage).toContain('<h1>Something else</h1>')
    expect(render('# All features\n\nx', { title: undefined }).storage).toContain('<h1>')
  })

  it('does not turn a mixed list into a task list', () => {
    const out = render('- [ ] task\n- plain').storage
    expect(out).not.toContain('ac:task-list')
    expect(out).toContain('<li>[ ] task</li>')
  })
})

describe('banner', () => {
  it('links to the file at the commit and is well-formed', () => {
    const b = banner({ repoUrl: 'https://github.com/o/r', sha: 'abcdef1234567', file: 'docs/a.md' })
    expect(b).toContain('href="https://github.com/o/r/blob/abcdef1234567/docs/a.md"')
    expect(b).toContain('<code>abcdef1</code>')
    expect(wellFormed(b)).toBe(true)
  })
})
