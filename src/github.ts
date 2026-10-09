const MARKER = '<!-- confluence-sync -->'

/**
 * Creates or updates the single confluence-sync comment on a pull request, so
 * each push edits the same comment instead of adding a new one.
 */
export async function upsertPrComment({ repo, pr, token, body }: { repo: string; pr: number; token: string; body: string }) {
  const api = async (method: string, path: string, payload?: unknown) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return res.json()
  }
  const full = `${MARKER}\n${body}`
  for (let page = 1; ; page++) {
    const comments = (await api('GET', `/issues/${pr}/comments?per_page=100&page=${page}`)) as { id: number; body?: string }[]
    const mine = comments.find((c) => c.body?.startsWith(MARKER))
    if (mine) return api('PATCH', `/issues/comments/${mine.id}`, { body: full })
    if (comments.length < 100) break
  }
  return api('POST', `/issues/${pr}/comments`, { body: full })
}

export interface PinnedPage {
  file: string
  pageId: string
  title?: string
  status: string
}

/**
 * The mapping file's text with `"pageId"` added after the `"file"` of each given
 * entry. The rest of the text, its formatting included, is kept as is. Entries are
 * matched by their normalized file path.
 */
export function pinPageIds(raw: string, pins: PinnedPage[], normalize: (p: string) => string): string {
  const parsed = JSON.parse(raw) as { pages: { file: string; pageId?: string }[] }
  let text = raw
  for (const pin of pins) {
    const entry = parsed.pages.find((p) => !p.pageId && normalize(p.file) === pin.file)
    if (!entry) continue
    const pattern = new RegExp(`("file"\\s*:\\s*)${escapeRegExp(JSON.stringify(entry.file))}`)
    if (!pattern.test(text)) throw new Error(`Could not find the entry for ${pin.file} in the mapping file`)
    text = text.replace(pattern, (m) => `${m}, "pageId": ${JSON.stringify(pin.pageId)}`)
  }
  // The result must still be the same mapping, plus the ids.
  const check = JSON.parse(text) as { pages: { file: string; pageId?: string }[] }
  for (const pin of pins) {
    if (!check.pages.some((p) => normalize(p.file) === pin.file && p.pageId === pin.pageId)) {
      throw new Error(`Pinning ${pin.file} produced an unexpected mapping`)
    }
  }
  return text
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pull request description listing the pinned pages. */
export function pinPrBody(pins: PinnedPage[], configPath: string): string {
  return [
    `confluence-sync found or created these pages, which had no \`pageId\` in \`${configPath}\`. This PR records their ids, so later runs use them directly and a renamed page is never created again.`,
    '',
    '| File | Page id | Title | How |',
    '|---|---|---|---|',
    ...pins.map((p) => `| \`${p.file}\` | ${p.pageId} | ${p.title ?? ''} | ${p.status === 'created' ? 'created' : 'found by title'} |`),
  ].join('\n')
}

/**
 * Opens (or updates) one pull request that writes the pinned mapping to `branch`.
 * Needs a token with `contents: write` and `pull-requests: write`. Returns the PR URL.
 */
export async function openPinPr({
  repo,
  token,
  base,
  path,
  content,
  body,
  branch = 'confluence-sync/pin-page-ids',
}: { repo: string; token: string; base: string; path: string; content: string; body: string; branch?: string }): Promise<string> {
  const api = async (method: string, apiPath: string, payload?: unknown, okStatuses: number[] = []) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`GitHub ${method} ${apiPath} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return { status: res.status, json: res.status === 204 ? undefined : await res.json() }
  }
  const baseRef = await api('GET', `/git/ref/heads/${encodeURIComponent(base)}`)
  const created = await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: baseRef.json.object.sha }, [422])
  if (created.status === 422) {
    // The branch is left from an earlier run whose PR is still open: start it again from the base.
    await api('PATCH', `/git/refs/heads/${branch}`, { sha: baseRef.json.object.sha, force: true })
  }
  const file = await api('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`)
  await api('PUT', `/contents/${path}`, {
    message: 'Pin Confluence page ids created or found by confluence-sync',
    content: Buffer.from(content).toString('base64'),
    branch,
    sha: file.json.sha,
  })
  const owner = repo.split('/')[0]
  const open = await api('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
  if (open.json.length) {
    await api('PATCH', `/pulls/${open.json[0].number}`, { body })
    return open.json[0].html_url
  }
  const pr = await api('POST', '/pulls', { title: 'Pin Confluence page ids', head: branch, base, body })
  return pr.json.html_url
}
