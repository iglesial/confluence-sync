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
