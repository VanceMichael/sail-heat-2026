import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { SourceError } from './source-client.mjs'

export class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR') {
    super(message)
    this.code = code
  }
}

function parsePack(bytes, file) {
  let text
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    text = gunzipSync(buffer).toString('utf8')
  } else {
    text = buffer.toString('utf8')
  }
  const entries = []
  const problems = []
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      problems.push({ line: index + 1, error: '不是合法 JSON' })
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push({ line: index + 1, error: '条目不是对象' })
      continue
    }
    entries.push(value)
  }
  return { entries, problems, file, sha256: createHash('sha256').update(buffer).digest('hex') }
}

export function createProviderClient({ base, fetchImpl, timeoutMs = 15000 } = {}) {
  const request = fetchImpl || fetch
  const root = base || 'http://127.0.0.1:8701'
  async function call(path, options = {}) {
    const url = new URL(path, root.endsWith('/') ? root : root + '/')
    try {
      return await request(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new ProviderError(`无法连接外部接口 ${root}（${error.message}）`, 'NETWORK')
    }
  }

  async function jsonOrNull(path, options) {
    const response = await call(path, options)
    if (response.status === 404) return { response, value: null, notFound: true }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ProviderError(`外部接口 ${path} 返回 HTTP ${response.status}${body ? '：' + body.slice(0, 200) : ''}`, 'HTTP')
    }
    return { response, value: await response.json() }
  }

  return {
    root,
    call,
    async exports() {
      const { value, notFound } = await jsonOrNull('/shore/exports')
      if (notFound) return []
      if (!Array.isArray(value)) throw new ProviderError('岸站导出清单格式不正确', 'EXPORTS')
      return value
    },
    async pack(file) {
      const response = await call(file)
      if (!response.ok) throw new ProviderError(`无法领取岸站观测包 ${file}（HTTP ${response.status}）`, 'PACK')
      const bytes = Buffer.from(await response.arrayBuffer())
      return { ...parsePack(bytes, file), etag: response.headers.get('etag') }
    },
    async photo(id) {
      const response = await call('/shore/photo?id=' + encodeURIComponent(id))
      if (response.status === 410) {
        return { id, status: 410, state: 'expired', message: await response.text().catch(() => '') }
      }
      if (response.status === 404) {
        return { id, status: 404, state: 'missing', message: await response.text().catch(() => '') }
      }
      if (!response.ok) {
        return { id, status: response.status, state: 'error', message: await response.text().catch(() => '') }
      }
      return {
        id,
        status: response.status,
        state: 'available',
        type: response.headers.get('content-type') || 'application/octet-stream',
        etag: response.headers.get('etag'),
        bytes: Buffer.from(await response.arrayBuffer())
      }
    },
    async probePhoto(id) {
      const response = await call('/shore/photo?id=' + encodeURIComponent(id), { headers: { Range: 'bytes=0-0' } })
      if (response.status === 410) return { id, status: 410, state: 'expired', message: await response.text().catch(() => '') }
      if (response.status === 404) return { id, status: 404, state: 'missing' }
      if (response.status === 206 || response.status === 200) {
        return { id, status: response.status, state: 'available', etag: response.headers.get('etag') }
      }
      return { id, status: response.status, state: 'error', message: await response.text().catch(() => '') }
    },
    async claims() {
      const { value, notFound } = await jsonOrNull('/jury/claims')
      if (notFound) return []
      if (!Array.isArray(value)) throw new ProviderError('异议清单格式不正确', 'CLAIMS')
      return value
    },
    async receipts() {
      const { value, notFound } = await jsonOrNull('/jury/receipts')
      if (notFound) return []
      if (!Array.isArray(value)) throw new ProviderError('签收回读格式不正确', 'RECEIPTS')
      return value
    },
    async correction(payload) {
      const response = await call('/jury/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        throw new ProviderError(`裁判接口拒绝改号（HTTP ${response.status}）${text ? '：' + text.slice(0, 200) : ''}`, 'CORRECTION')
      }
      let value = null
      if (text) {
        try {
          value = JSON.parse(text)
        } catch {
          value = { state: 'received', raw: text.slice(0, 200) }
        }
      }
      return { value, status: response.status }
    }
  }
}

export function packKey(exportRow) {
  return [exportRow.station, exportRow.boot, exportRow.offset, exportRow.error, exportRow.file].join('|')
}
