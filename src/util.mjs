import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const nowIso = () => new Date().toISOString()

export function shortHash(value, length = 16) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, length)
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function parseTsv(text, columns, label = '记录') {
  const rows = []
  const lines = text.split(/\r?\n/).filter(line => line.length > 0)
  for (const [index, line] of lines.entries()) {
    const row = line.split('\t')
    if (row.length !== columns) {
      throw new Error(`${label}第 ${index + 1} 行列数为 ${row.length}，应为 ${columns}`)
    }
    rows.push(row)
  }
  return rows
}

export function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function rangeOverlapsWindow(range, window) {
  return range.from < window.to && range.to >= window.from
}

export function rangeInsideWindow(range, window) {
  return range.from >= window.from && range.to < window.to
}

export function inWindow(time, window) {
  return time >= window.from && time < window.to
}

export function rangeText(range) {
  return range ? `[${range.from}, ${range.to}]` : '—'
}

export function windowText(window) {
  return window ? `[${window.from}, ${window.to})` : '—'
}

export async function atomicWriteJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), '.' + randomUUID() + '.tmp')
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, file)
}

export async function readJsonIfPresent(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withFileLock(directory, task, { timeoutMs = 8000, staleMs = 60000 } = {}) {
  await mkdir(directory, { recursive: true })
  const lockPath = join(directory, '.lock')
  const started = Date.now()
  let handle = null
  for (;;) {
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockPath, { force: true })
          continue
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() - started > timeoutMs) throw new Error('数据目录正被其他进程占用')
      await sleep(40)
    }
  }
  try {
    return await task()
  } finally {
    await handle.close().catch(() => {})
    await rm(lockPath, { force: true })
  }
}

export function compareCodeUnits(left, right) {
  return String(left).localeCompare(String(right), 'zh-Hans-CN')
}

export function unique(values) {
  return [...new Set(values)]
}

export function groupBy(items, key) {
  const output = new Map()
  for (const item of items) {
    const group = key(item)
    if (!output.has(group)) output.set(group, [])
    output.get(group).push(item)
  }
  return output
}

export function formatSeconds(value) {
  return value === null || value === undefined ? '—' : `${value}s`
}

export function table(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map(row => displayWidth(String(row[column] ?? '')))))
  const render = row => row.map((value, column) => pad(String(value ?? ''), widths[column])).join('  ')
  return [render(headers), widths.map(width => '─'.repeat(width)).join('  '), ...rows.map(render)].join('\n')
}

function displayWidth(value) {
  let width = 0
  for (const character of value) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(character) ? 2 : 1
  return width
}

function pad(value, width) {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}
