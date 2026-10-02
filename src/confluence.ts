/** Minimal Confluence Cloud REST client (v2 API, plus v1 for attachment upload). */

export interface PageInfo {
  id: string
  title: string
  version: number
  spaceId: string
  /** As reported by Confluence (may be the space homepage); compared with the mapping's parent. */
  parentId?: string
}

export interface SyncProperty {
  hash: string
  sha: string
  file: string
  repo: string
}

export const PROPERTY_KEY = 'confluence-sync'

export interface ConfluenceClient {
  getPage(id: string): Promise<PageInfo>
  attachmentNames(id: string): Promise<Set<string>>
  uploadAttachment(id: string, name: string, data: Buffer, contentType: string): Promise<void>
  getSyncProperty(id: string): Promise<SyncProperty | null>
  setSyncProperty(id: string, value: SyncProperty): Promise<void>
  updatePage(id: string, page: { title: string; storage: string; version: number; message: string }): Promise<void>
  /** Makes `id` the last child of `parentId`. */
  movePage(id: string, parentId: string): Promise<void>
}

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * `email` + `token` → basic auth (Atlassian Cloud API token);
 * `token` alone → bearer (personal access token).
 */
export function createConfluenceClient({ baseUrl, email, token }: { baseUrl: string; email?: string; token: string }): ConfluenceClient {
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`

  async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const isForm = body instanceof FormData
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500)
      const hint =
        res.status === 401 ? ' (check the token and email)'
        : res.status === 403 || res.status === 404 ? ' (wrong page id, or the token cannot see this page)'
        : ''
      throw new ConfluenceError(`${method} ${path} → ${res.status}${hint}: ${text}`, res.status)
    }
    const raw = await res.text()
    return (raw ? JSON.parse(raw) : undefined) as T
  }

  async function findProperty(id: string) {
    const r = await call<{ results: { id: string; key: string; value: SyncProperty; version: { number: number } }[] }>(
      'GET',
      `/api/v2/pages/${id}/properties?key=${PROPERTY_KEY}`,
    )
    return r.results[0]
  }

  return {
    async getPage(id) {
      const p = await call<{ id: string; title: string; version: { number: number }; spaceId: string; parentId?: string | null }>(
        'GET',
        `/api/v2/pages/${id}`,
      )
      return { id: p.id, title: p.title, version: p.version.number, spaceId: p.spaceId, parentId: p.parentId ?? undefined }
    },

    async attachmentNames(id) {
      const names = new Set<string>()
      let next: string | undefined = `/api/v2/pages/${id}/attachments?limit=250`
      while (next) {
        const r: { results: { title: string }[]; _links?: { next?: string } } = await call('GET', next)
        r.results.forEach((a) => names.add(a.title))
        // _links.next is relative to the site root and already contains /wiki.
        next = r._links?.next?.replace(/^\/wiki/, '')
      }
      return names
    },

    async uploadAttachment(id, name, data, contentType) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), name)
      form.append('minorEdit', 'true')
      // v2 has no upload endpoint; PUT creates the attachment or adds a version.
      await call('PUT', `/rest/api/content/${id}/child/attachment`, form, { 'X-Atlassian-Token': 'no-check' })
    },

    async getSyncProperty(id) {
      return (await findProperty(id))?.value ?? null
    },

    async setSyncProperty(id, value) {
      const existing = await findProperty(id)
      if (existing) {
        await call('PUT', `/api/v2/pages/${id}/properties/${existing.id}`, {
          key: PROPERTY_KEY,
          value,
          version: { number: existing.version.number + 1 },
        })
      } else {
        await call('POST', `/api/v2/pages/${id}/properties`, { key: PROPERTY_KEY, value })
      }
    },

    async movePage(id, parentId) {
      // v2 has no move endpoint.
      await call('PUT', `/rest/api/content/${id}/move/append/${parentId}`)
    },

    async updatePage(id, { title, storage, version, message }) {
      await call('PUT', `/api/v2/pages/${id}`, {
        id,
        status: 'current',
        title,
        body: { representation: 'storage', value: storage },
        version: { number: version, message },
      })
    },
  }
}
