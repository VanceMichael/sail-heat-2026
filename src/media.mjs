import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nowIso } from './util.mjs'

export function extensionFor(type, name = '') {
  if (type === 'image/png') return 'png'
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'audio/wav' || type === 'audio/x-wav') return 'wav'
  if (type === 'application/gzip') return 'gz'
  const named = /\.(png|jpe?g|wav|gz|json)$/i.exec(name)
  if (named) return named[1].toLowerCase().replace('jpeg', 'jpg')
  return 'bin'
}

export async function storeMedia(directory, { name, bytes, type }) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const folder = join(directory, 'media', sha256.slice(0, 2))
  const extension = extensionFor(type, name)
  const path = join(folder, `${sha256}.${extension}`)
  await mkdir(folder, { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  return {
    name,
    sha256,
    type,
    bytes: bytes.length,
    path: path.slice(directory.length + 1),
    storedAt: nowIso()
  }
}
