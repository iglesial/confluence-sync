import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MERMAID_CLI = '@mermaid-js/mermaid-cli@11'

/**
 * Renders Mermaid diagrams to PNG on the runner with mermaid-cli (headless
 * Chromium). The CLI is fetched with npx on first use only, so repos without
 * diagrams don't pay for it. Results are cached by source for the whole run.
 */
export function createMermaidRenderer() {
  const cache = new Map<string, Promise<Buffer>>()
  let dir: string | undefined

  async function render(source: string): Promise<Buffer> {
    dir ??= mkdtempSync(join(tmpdir(), 'confluence-sync-mermaid-'))
    const id = String(cache.size)
    const input = join(dir, `${id}.mmd`)
    const output = join(dir, `${id}.png`)
    const puppeteer = join(dir, 'puppeteer.json')
    writeFileSync(input, source)
    // GitHub-hosted runners need --no-sandbox for Chromium.
    writeFileSync(puppeteer, JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }))
    try {
      await run('npx', ['-y', MERMAID_CLI, '-i', input, '-o', output, '-p', puppeteer, '-b', 'white', '-s', '2', '-q'], {
        timeout: 180_000,
        shell: process.platform === 'win32',
      })
    } catch (e) {
      const err = e as { stderr?: string; message: string }
      const detail = (err.stderr || err.message).trim().split('\n').slice(-6).join('\n')
      throw new Error(`Mermaid diagram failed to render:\n${detail}`)
    }
    return readFileSync(output)
  }

  return (source: string): Promise<Buffer> => {
    if (!cache.has(source)) cache.set(source, render(source))
    return cache.get(source)!
  }
}

export type MermaidRenderer = ReturnType<typeof createMermaidRenderer>
