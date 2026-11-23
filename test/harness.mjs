import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { openSail } from '../src/engine.mjs'

export async function listen(server, t) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

export async function harness(t) {
  const source = createSource()
  const lab = provider()
  const sourceBase = await listen(source, t)
  const providerBase = await listen(lab, t)
  const dataDir = await mkdtemp(join(tmpdir(), 'sail-test-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const sail = await openSail({ dataDir, sourceBase, providerBase })
  return {
    sail,
    dataDir,
    sourceBase,
    providerBase,
    async stage(name) {
      const response = await fetch(providerBase + '/lab?stage=' + encodeURIComponent(name), { method: 'POST' })
      if (!response.ok) throw new Error('无法切换演练档 ' + name)
      return response.json()
    },
    async edition(name) {
      const response = await fetch(sourceBase + '/control?edition=' + encodeURIComponent(name), { method: 'POST' })
      if (!response.ok) throw new Error('无法切换资料版 ' + name)
      return response.json()
    }
  }
}

export function observationIdsBySeq(state) {
  const output = {}
  for (const observation of Object.values(state.observations)) {
    output[`${observation.station}/${observation.seq}`] = observation.id
  }
  return output
}
