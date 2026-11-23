import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness, observationIdsBySeq } from './harness.mjs'

async function prepared(t, { edition = 'r1', stage = 'before-recall', originals = true } = {}) {
  const h = await harness(t)
  await h.stage(stage)
  await h.edition(edition)
  await h.sail.syncProvider({ refresh: true })
  if (originals) await h.sail.fetchOriginals()
  return h
}

test('岸站按部署代换算的边界不确定观察留为争议，不把旧轮位置算进重跑', async t => {
  const h = await prepared(t, { edition: 'r2', stage: 'recalled' })
  const ids = observationIdsBySeq(await h.sail.state())
  const boundary = (await h.sail.state()).observations[ids['T/2']]
  // 召回后 T 站 offset -3 ± 5：local 62 → [54, 64]，跨 60 秒召回边界
  assert.deepEqual(boundary.clock, { from: 54, to: 64, exact: false, basis: 'device', offset: -3, error: 5 })
  const pack = boundary.packId
    ? boundary
    : (await h.sail.state()).observations[ids['T/2']]
  assert.ok(pack, '设备包观察存在')
  const state = await h.sail.state()
  const conflicting = Object.values(state.observations).filter(observation =>
    observation.photo === 'v3' && observation.state === 'disputed')
  assert.ok(conflicting.length >= 1)
  for (const observation of conflicting) {
    assert.ok(observation.conflicts.length >= 1)
    assert.ok(observation.conflicts.every(conflict => conflict.note.includes('保留两种证据')))
  }
})

test('按航轮窗、必过点次序与现场方向取证，不把不同轮的必过点拼齐', async t => {
  const h = await harness(t)
  await h.stage('before-recall')
  await h.edition('r2')
  await h.sail.syncProvider({ refresh: true })
  const heats = (await h.sail.state()).derived.heats
  const oldHeat = heats.find(heat => heat.id === 'G/H1')
  const newHeat = heats.find(heat => heat.id === 'G/H2')
  assert.deepEqual([oldHeat.from, oldHeat.to, oldHeat.boundBy], [0, 60, 'recall'])
  assert.deepEqual([newHeat.from, newHeat.to], [60, 150])
  assert.deepEqual(oldHeat.marks.map(mark => `${mark.order}${mark.station}${mark.direction}`), ['1Seast', '2Twest'])
  assert.deepEqual(newHeat.marks.map(mark => `${mark.order}${mark.station}${mark.direction}`), ['1Twest', '2Seast'])

  const state = await h.sail.state()
  const ids = observationIdsBySeq(state)
  const { buildPassage } = await import('../src/model.mjs')
  const passage = buildPassage(state, 'G/H2', 'P')
  // P 在重跑只有 T 点（争议未定）与 S/4；旧轮 S/1、T/1 不得拼入
  assert.ok(passage.usedObservationIds.every(id => id !== ids['S/1'] && id !== ids['T/1']))
  assert.equal(passage.singleHeat, true)
  assert.ok(ids['S/4'])
  const q = buildPassage(state, 'G/H1', 'Q')
  assert.ok(!q.usedObservationIds.includes(ids['S/4']), '号牌 9 的旧摘要不能算给 Q')
})

test('裁判改号只改变相应观察归属，未确认与已撤销的原轮证据可查', async t => {
  const h = await prepared(t, { edition: 'r2', stage: 'recalled' })
  const state = await h.sail.state()
  const ids = observationIdsBySeq(state)
  const target = ids['S/4']
  await h.sail.correct({ receipt: 'doc1', observation: target, bib: '8' })
  const after = await h.sail.state()
  const observation = after.observations[target]
  assert.equal(observation.bib, '8')
  assert.equal(observation.rawBib, '9')
  assert.equal(observation.attribution.person, 'Q')
  assert.equal(observation.attribution.heatId, 'G/H2')
  // 另一份 v7 摘要是真号牌 8，不受改号影响
  assert.equal(after.observations[ids['T/3']].bib, '8')

  await h.sail.recordDecision(ids['T/3'], 'revoked', { actor: 'jury' })
  const revoked = (await h.sail.state()).observations[ids['T/3']]
  assert.equal(revoked.state, 'revoked')
  const { buildPassage } = await import('../src/model.mjs')
  const passage = buildPassage(await h.sail.state(), 'G/H2', 'Q')
  const revokedView = passage.entries.flatMap(entry => entry.revoked)
  assert.ok(revokedView.some(item => item.id === ids['T/3']))
  assert.ok(!passage.usedObservationIds.includes(ids['T/3']))
})

test('原件过期后只保留已有材料，不拿重跑后的新照片补位', async t => {
  const h = await prepared(t, { edition: 'r2', stage: 'before-recall' })
  const ids = observationIdsBySeq(await h.sail.state())
  const packId = ids['T/2']
  let state = await h.sail.state()
  assert.equal(state.observations[packId].original.state, 'available')
  assert.ok(state.observations[packId].original.media)

  await h.stage('recalled')
  await h.sail.syncProvider({ refresh: false })
  const results = await h.sail.fetchOriginals()
  state = await h.sail.state()
  const observation = state.observations[packId]
  assert.equal(observation.original.shoreState, 'index-only')
  assert.equal(observation.original.state, 'archived')
  assert.ok(observation.original.media, '已留档的原件仍在')
  assert.ok(results.some(item => item.id === packId && item.state === 'archived'))

  const { buildPassage } = await import('../src/model.mjs')
  const passage = buildPassage(state, 'G/H1', 'P')
  const v3 = passage.entries.flatMap(entry => [...entry.disputed, ...entry.alternatives]).find(item => item.photo === 'v3')
  assert.ok(v3, '片段 v3 有争议证据')
  // 新的重跑照片 v7 属于 T/3，不补到旧轮 T/2
  assert.ok(!passage.usedObservationIds.includes(ids['T/3']))
})

test('多个候选代表同一必过点时，交出的材料说明合法次序内实际采用的证据', async t => {
  const h = await prepared(t, { edition: 'r2', stage: 'recalled' })
  const { handoffPacket } = await import('../src/report.mjs')
  const packet = handoffPacket(await h.sail.state(), 'G/H2', 'Q')
  assert.ok(packet.order.every(entry => entry.status === 'used' || entry.status === 'missing'))
  const usedCount = packet.order.filter(entry => entry.status === 'used').length
  assert.equal(packet.usedObservationIds.length, usedCount)
  assert.ok(packet.note.includes('不与其他航轮'))
  const byOrder = packet.order.map(entry => entry.order)
  assert.deepEqual(byOrder, [1, 2])
  // 每个采用点必须来自同一轮
  const { buildPassage } = await import('../src/model.mjs')
  const passage = buildPassage(await h.sail.state(), 'G/H2', 'Q')
  assert.ok(passage.usedHeatIds.every(heat => heat === 'G/H2'))
})

test('签收无争议人员；异议只锁受影响的签收件；其他件继续可用', async t => {
  const h = await prepared(t, { edition: 'r1', stage: 'before-recall' })
  const signed = await h.sail.signoff({ person: 'P', heat: 'G/H1' })
  assert.equal(signed.signoff.state, 'signed')
  assert.ok(signed.signoff.baseline.usedObservationIds.length >= 1)

  await assert.rejects(
    h.sail.signoff({ person: 'Q', heat: 'G/H1' }),
    /不能签收/)

  await h.stage('recalled')
  await h.edition('r2')
  await h.sail.syncProvider({ refresh: true })
  let state = await h.sail.state()
  assert.equal(state.signoffs.doc1.lock.claim, 'E1')
  const { signoffStatus } = await import('../src/store.mjs')
  assert.equal(state.signoffs.docK.lock, null)
  assert.equal(signoffStatus(state, state.signoffs.docK), 'signed')

  await h.stage('ruling')
  await h.sail.syncProvider({ refresh: false })
  state = await h.sail.state()
  assert.equal(state.signoffs.doc1.juryState, 'challenged')
  assert.equal(state.signoffs.doc1.lock.claim, 'E1')
  assert.equal(signoffStatus(state, state.signoffs.doc1), 'challenged')
  assert.equal(signoffStatus(state, state.signoffs.docK), 'signed')
})

test('确认新资料改变已签收选手时发可查原依据的勘误，并列两人的缺口', async t => {
  const h = await prepared(t, { edition: 'r1', stage: 'before-recall' })
  await h.stage('recalled')
  const issued = await h.sail.issueErrata({ outboxDir: join(h.dataDir, 'outbox') })
  for (const errata of issued) {
    assert.ok(errata.atSigning.usedObservationIds.length >= 1)
    assert.ok(Array.isArray(errata.people))
  }
  const ids = observationIdsBySeq(await h.sail.state())
  await h.sail.correct({ receipt: 'doc1', observation: ids['S/4'], bib: '8' })
  const plans = await h.sail.issueErrata({ outboxDir: join(h.dataDir, 'outbox') })
  assert.ok(plans.length >= 1, '改号后应生成勘误')
  const errata = plans[0]
  const people = errata.people.map(person => person.person)
  assert.ok(people.includes('P'))
  assert.ok(people.includes('Q'))
  const q = errata.people.find(person => person.person === 'Q')
  assert.ok(Array.isArray(q.current.missingOrders))
  const text = await readFile(join(h.dataDir, 'outbox', `${errata.id}.md`), 'utf8')
  assert.match(text, /原签收依据/)
  assert.match(text, /其他签收件/)
  assert.match(text, /受影响人员/)
})

test('值班可查询岸站仍可补的原件、每轮每人的经过与各件签收或审理状态', async t => {
  const h = await prepared(t, { edition: 'r1', stage: 'before-recall' })
  await h.stage('recalled')
  await h.edition('r2')
  await h.sail.syncProvider({ refresh: true })
  await h.sail.fetchOriginals()
  const state = await h.sail.state()
  const available = Object.values(state.observations)
    .filter(observation => observation.original?.state === 'available')
  assert.ok(available.length >= 1, '仍有岸站原件可按索引补取')
  const lost = Object.values(state.observations)
    .filter(observation => observation.original?.shoreState === 'index-only')
  assert.equal(lost.length, 1)
  assert.ok(lost[0].original.media, '已过期原件仍可查已留档材料')
  assert.equal(lost[0].original.state, 'archived')
  const { buildPassages } = await import('../src/model.mjs')
  const passages = buildPassages(state, { includeEmpty: true })
  assert.ok(passages.length >= 4)
  for (const passage of passages) {
    assert.ok(Array.isArray(passage.entries))
    assert.equal(passage.entries.length, passage.marks.length)
  }
  const { signoffStatus } = await import('../src/store.mjs')
  assert.equal(signoffStatus(state, state.signoffs.doc1), 'challenged')
  assert.equal(signoffStatus(state, state.signoffs.docK), 'signed')
})

test('岸站原件尚未建索引时按待补处理，不冒充可用证据', async t => {
  const h = await harness(t)
  await h.stage('before-recall')
  await h.edition('r2')
  await h.sail.syncProvider({ refresh: true })
  await h.sail.fetchOriginals()
  const state = await h.sail.state()
  const ids = observationIdsBySeq(state)
  const pending = state.observations[ids['T/3']]
  assert.equal(pending.original.state, 'not-indexed')
  const { buildPassage } = await import('../src/model.mjs')
  const passage = buildPassage(state, 'G/H2', 'Q')
  const entry = passage.entries[0]
  assert.ok(!passage.usedObservationIds.includes(ids['T/3']), '未建索引的设备包不被采用')
  assert.ok(entry.pendingOriginals.some(item => item.id === ids['T/3']))
  assert.ok(passage.usedObservationIds.every(id => id !== ids['T/3']))
})

test('同步可反复执行且状态稳定', async t => {
  const h = await harness(t)
  await h.stage('recalled')
  await h.edition('r2')
  const first = await h.sail.syncProvider({ refresh: true })
  const second = await h.sail.syncProvider({ refresh: true })
  assert.equal(second.packs, first.packs)
  assert.equal(second.claims, first.claims)
  const state = await h.sail.state()
  assert.ok(Object.keys(state.observations).length >= 8)
  assert.equal(new Set(Object.values(state.observations).filter(o => o.kind === 'sight').map(o => o.photo)).size, 7)
})
