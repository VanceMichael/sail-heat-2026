import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

import { gunzipSync } from 'node:zlib'
test('召回后同一识别包有不同现场锚点，异议只作用已签名单项', async t => {
  const root = await listen(t)
  const pack = Buffer.from(await (await fetch(root + '/shore/observations')).arrayBuffer())
  assert.equal(JSON.parse(gunzipSync(pack).toString().split('
')[0]).local, 62)
  await post(root, '/lab?stage=recalled')
  assert.equal((await (await fetch(root + '/shore/exports')).json())[0].error, 5)
  assert.equal((await fetch(root + '/shore/photo?id=v3')).status, 410)
  assert.equal((await post(root, '/jury/corrections', { receipt: 'doc1' })).status, 202)
  await post(root, '/lab?stage=ruling')
  assert.equal((await (await fetch(root + '/jury/receipts')).json())[1].state, 'signed')
})
