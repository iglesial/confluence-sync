import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import * as core from '@actions/core'
import { loadConfig, normalizePath } from './config.ts'
import { createConfluenceClient } from './confluence.ts'
import { openPinPr, pinPageIds, pinPrBody, upsertPrComment } from './github.ts'
import { createMermaidRenderer } from './mermaid.ts'
import { type PageResult, resultsTable, syncAll } from './sync.ts'

async function main() {
  const repoRoot = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), core.getInput('working-directory') || '.')
  const repo = process.env.GITHUB_REPOSITORY ?? 'local/repo'
  const repoUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}`
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const isPr = event === 'pull_request' || event === 'pull_request_target'
  const payload = process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {}
  // On PRs GITHUB_SHA is a temporary merge commit; link to the PR head instead.
  const sha: string = payload.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? 'HEAD'

  const token = core.getInput('token')
  const dryRun = core.getBooleanInput('dry-run') || isPr
  const mermaid = core.getInput('mermaid') === 'code' ? 'code' : 'local'

  if (!token && !dryRun) throw new Error('The token input is required to publish (it may only be empty in dry-run or pull request checks).')
  if (!token) core.warning('No Confluence token (e.g. a pull request from a fork): running offline checks only.')

  const configPath = core.getInput('config') || 'docs/confluence.json'
  const { config, errors } = loadConfig(configPath, repoRoot, core.getInput('base-url'))
  let results: PageResult[] = []
  if (config) {
    results = await syncAll({
      config,
      repoRoot,
      repo,
      repoUrl,
      sha,
      client: token ? createConfluenceClient({ baseUrl: config.baseUrl, email: core.getInput('email') || undefined, token }) : undefined,
      mode: dryRun ? 'check' : 'publish',
      mermaid,
      banner: core.getBooleanInput('banner'),
      renderMermaid: createMermaidRenderer(),
      log: (m) => core.info(m),
    })
  }

  // Pages found or created for entries without pageId: optionally record their ids in a PR.
  const pins = config
    ? results.filter((r) => r.pageId && !config.pages.find((p) => p.file === r.file)?.pageId && r.status !== 'error')
    : []
  let pinNote: string | undefined
  if (!dryRun && pins.length && core.getBooleanInput('pin-created-ids')) {
    try {
      const raw = readFileSync(resolve(repoRoot, configPath), 'utf8')
      const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd()
      const url = await openPinPr({
        repo,
        token: core.getInput('github-token'),
        base: process.env.GITHUB_REF_NAME ?? 'main',
        path: normalizePath(relative(workspace, resolve(repoRoot, configPath))),
        content: pinPageIds(raw, pins, normalizePath),
        body: pinPrBody(pins, configPath),
      })
      pinNote = `Page ids recorded in ${url}`
      core.info(pinNote)
    } catch (e) {
      // The pages are synced either way; a later run finds them again by title.
      core.warning(`Could not open the pull request pinning the page ids: ${(e as Error).message}`)
    }
  }

  const failed = errors.length || results.some((r) => r.status === 'error')
  const heading = isPr
    ? `### 📄 Confluence preview: ${failed ? '❌ fix the errors below before merging' : 'pages are valid; they will be published on merge'}`
    : `### 📄 Confluence sync${dryRun ? ' (dry run, nothing written)' : ''}`
  const report = [
    heading,
    ...(errors.length ? [`**Mapping errors:**\n${errors.map((e) => `- ${e}`).join('\n')}`] : []),
    ...(results.length ? [resultsTable(results)] : []),
    ...(token ? [] : ['_Offline check only: no Confluence token was available._']),
    ...(pinNote ? [pinNote] : []),
  ].join('\n\n')

  // Full storage XHTML for dry runs goes to the log and the summary, never the PR comment.
  for (const r of results.filter((r) => r.storage)) {
    core.startGroup(`${r.file} → Confluence storage format`)
    core.info(r.storage!)
    core.endGroup()
  }
  await core.summary
    .addRaw(report)
    .addRaw(
      results
        .filter((r) => r.storage)
        .map((r) => `\n\n<details><summary><code>${r.file}</code> storage format</summary>\n\n\`\`\`xml\n${r.storage}\n\`\`\`\n</details>`)
        .join(''),
    )
    .write()

  if (isPr && payload.pull_request?.number && core.getBooleanInput('pr-comment')) {
    try {
      await upsertPrComment({ repo, pr: payload.pull_request.number, token: core.getInput('github-token'), body: report })
    } catch (e) {
      // Fork PRs get a read-only GITHUB_TOKEN: the summary still has the report.
      core.warning(`Could not post the PR comment: ${(e as Error).message}`)
    }
  }

  core.setOutput('results', JSON.stringify(results.map(({ storage: _s, ...r }) => r)))
  if (failed) core.setFailed('Some pages could not be synced; see the summary.')
}

main().catch((e) => core.setFailed((e as Error).message))
