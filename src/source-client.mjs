import { parseTsv } from './util.mjs'

export const STREAMS = {
  starts: { columns: 5, label: '航轮', names: ['group', 'heat', 'route', 'action', 'clock'] },
  marks: { columns: 4, label: '必过点', names: ['route', 'order', 'station', 'direction'] },
  fleet: { columns: 5, label: '组员', names: ['group', 'person', 'bib', 'from', 'to'] },
  sight: { columns: 6, label: '值班摘要', names: ['station', 'seq', 'clock', 'bib', 'direction', 'media'] },
  amend: { columns: 3, label: '改号', names: ['station', 'seq', 'bib'] },
  issued: { columns: 4, label: '签收', names: ['group', 'heat', 'person', 'receipt'] }
}

export class SourceError extends Error {
  constructor(message, code = 'SOURCE_ERROR') {
    super(message)
    this.code = code
  }
}

export function createSourceClient({ base, fetchImpl, timeoutMs } = {}) {
  const fetchImplResolved = fetchImpl || fetch
  const root = base || 'http://127.0.0.1:8700'
  async function request(path, options = {}) {
    const url = new URL(path, root.endsWith('/') ? root : root + '/')
    try {
      return await fetchImplResolved(url, { ...options, signal: AbortSignal.timeout(timeoutMs || 15000) })
    } catch (error) {
      throw new SourceError(`无法连接资料来源 ${root}（${error.message}）`, 'NETWORK')
    }
  }
  return {
    root,
    request,
    async catalog(edition) {
      const query = edition ? '?edition=' + encodeURIComponent(edition) : ''
      const response = await request('/catalog' + query)
      if (!response.ok) throw new SourceError(`无法读取资料目录（HTTP ${response.status}）`, 'CATALOG')
      return response.json()
    },
    async setEdition(edition) {
      const response = await request('/control?edition=' + encodeURIComponent(edition), { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new SourceError(body.error || `无法切换到资料版 ${edition}`, 'EDITION')
      return body
    },
    async health() {
      const response = await request('/health')
      if (!response.ok) throw new SourceError('来源不可用', 'HEALTH')
      return response.json()
    },
    async stream(name, { edition, key, from, until, etag, signal } = {}) {
      if (!STREAMS[name]) throw new SourceError(`没有数据流 ${name}`, 'STREAM')
      const rows = []
      let pageEtag = etag
      let path = '/records/' + name
      const params = new URLSearchParams()
      if (edition) params.set('edition', edition)
      if (key !== undefined && key !== null) params.set('key', String(key))
      if (from !== undefined && from !== null) params.set('from', String(from))
      if (until !== undefined && until !== null) params.set('until', String(until))
      if ([...params].length) path += '?' + params.toString()
      let editionSeen = null
      for (let page = 0; page < 500; page++) {
        const response = await request(path, { headers: pageEtag && page === 0 ? { 'If-None-Match': pageEtag } : {}, signal })
        if (response.status === 304) {
          return { rows: null, notModified: true, edition: editionSeen || edition || null, etag: pageEtag }
        }
        if (!response.ok) {
          throw new SourceError(`无法读取 ${name} 数据流（HTTP ${response.status}）`, 'STREAM')
        }
        const actual = response.headers.get('x-edition')
        if (editionSeen && actual && actual !== editionSeen) {
          throw new SourceError(`${name} 数据流在分页间更换了资料版（${editionSeen} → ${actual}）`, 'EDITION_CHANGED')
        }
        editionSeen = actual || editionSeen
        const text = await response.text()
        rows.push(...parseTsv(text, STREAMS[name].columns, STREAMS[name].label))
        const link = response.headers.get('link')
        if (!link) {
          pageEtag = response.headers.get('etag')
          break
        }
        const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)
        if (!match) throw new SourceError(`${name} 数据流的分页标记无法解析`, 'LINK')
        path = match[1]
      }
      return { rows, edition: editionSeen, etag: pageEtag }
    },
    async media(id) {
      const candidates = /\.(png|wav)$/i.test(id) ? [id] : [id, id + '.png', id + '.wav']
      let lastStatus = null
      for (const candidate of candidates) {
        const response = await request('/media/' + encodeURIComponent(candidate))
        if (response.ok) {
          return {
            id: candidate,
            type: response.headers.get('content-type') || 'application/octet-stream',
            bytes: Buffer.from(await response.arrayBuffer())
          }
        }
        lastStatus = response.status
        if (response.status !== 404) break
      }
      throw new SourceError(`无法领取原件 ${id}（HTTP ${lastStatus}）`, 'MEDIA')
    }
  }
}

export function decodeRows(stream, rows) {
  const names = STREAMS[stream].names
  return rows.map(values => Object.fromEntries(names.map((name, index) => [name, values[index]])))
}

export function referencedMedia(streams) {
  return [...new Set((streams.sight || []).map(row => row[5]))].sort()
}
