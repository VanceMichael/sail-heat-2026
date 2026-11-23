#!/usr/bin/env node
/**
 * 随场演练：在临时目录里跑一遍召回、争议、改号、勘误的完整流程。
 * 需要先启动来源与外部接口：npm run source / npm run provider
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSail } from '../src/engine.mjs'
import { buildPassages, buildPassage } from '../src/model.mjs'
import { signoffStatus } from '../src/store.mjs'
import { handoffPacket, renderHandoff, renderPassage, renderSignoffs } from '../src/report.mjs'

const sourceBase = process.env.SAIL_SOURCE || 'http://127.0.0.1:8700'
const providerBase = process.env.SAIL_PROVIDER || 'http://127.0.0.1:8701'

function heading(text) {
  process.stdout.write(`\n=== ${text} ===\n`)
}

async function stage(name) {
  const response = await fetch(providerBase + '/lab?stage=' + name, { method: 'POST' })
  if (!response.ok) throw new Error('无法切换演练档 ' + name)
}

async function edition(name) {
  const response = await fetch(sourceBase + '/control?edition=' + name, { method: 'POST' })
  if (!response.ok) throw new Error('无法切换资料版 ' + name)
}

const dataDir = await mkdtemp(join(tmpdir(), 'sail-demo-'))
const sail = await openSail({ dataDir, sourceBase, providerBase })
try {
  await stage('before-recall')
  await edition('r1')
  await sail.syncProvider({ refresh: true })
  await sail.fetchOriginals()
  heading('判罚前：按旧资料签收无争议人员')
  await sail.signoff({ heat: 'G/H1', person: 'P', actor: '计圈组' })
  process.stdout.write(renderSignoffs(await sail.state()) + '\n')

  await stage('recalled')
  await edition('r2')
  await sail.syncProvider({ refresh: true })
  heading('召回后：异议只锁受影响签收件')
  process.stdout.write(renderSignoffs(await sail.state()) + '\n')
  heading('重跑与旧轮的部分路段交叉，临近边界的观察留为争议')
  process.stdout.write(renderPassage(buildPassage(await sail.state(), 'G/H2', 'P')) + '\n')

  const ids = Object.fromEntries(Object.values((await sail.state()).observations).map(item => [`${item.station}/${item.seq}`, item.id]))
  await sail.correct({ receipt: 'doc1', observation: ids['S/4'], bib: '8', actor: '裁判' })
  heading('改号后：可查原依据的勘误，两人缺口分别列出')
  const issued = await sail.issueErrata({ actor: '值班', outboxDir: join(dataDir, 'outbox') })
  for (const errata of issued) {
    process.stdout.write(`勘误 ${errata.id}\n`)
    for (const person of errata.people) {
      const missing = person.current ? person.current.missingOrders : []
      process.stdout.write(`- ${person.person}${person.isSigned ? '（原签收人）' : ''}：${person.current?.complete ? '可拼齐' : '缺 ' + (missing.join('、') || '—')}\n`)
    }
    process.stdout.write(`  文件：${join(dataDir, 'outbox', errata.id + '.md')}\n`)
  }

  heading('交下一环节材料')
  process.stdout.write(renderHandoff(handoffPacket(await sail.state(), 'G/H2', 'Q')) + '\n')

  await stage('ruling')
  await sail.syncProvider({ refresh: false })
  heading('回读后：各件实际签收或审理状态')
  process.stdout.write(renderSignoffs(await sail.state()) + '\n')
  const passages = buildPassages(await sail.state(), { includeEmpty: true })
  process.stdout.write(`\n经过查询：${passages.length} 组；` +
    `可拼齐 ${passages.filter(item => item.complete).length} 组，` +
    `带未决 ${passages.filter(item => !item.complete).length} 组。\n`)
  const state = await sail.state()
  process.stdout.write(`签收状态：${Object.values(state.signoffs).map(item => `${item.receipt}=${signoffStatus(state, item)}`).join('，')}\n`)
  process.stdout.write(`\n演练数据目录：${dataDir}\n`)
} finally {
  if (!process.env.SAIL_KEEP) await rm(dataDir, { recursive: true, force: true })
}
