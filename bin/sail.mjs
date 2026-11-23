#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { openSail } from '../src/engine.mjs'
import { buildPassages, buildPassage } from '../src/model.mjs'
import { signoffStatus } from '../src/store.mjs'
import {
  handoffPacket, label, renderClaims, renderErrata, renderEvidence, renderEvidenceDetail, renderHandoff,
  renderCorrections, renderHeats, renderOriginals, renderPassage, renderPassages, renderSignoffDetail,
  renderSignoffs, renderStations
} from '../src/report.mjs'
import { table } from '../src/util.mjs'

const options = {
  data: { type: 'string', short: 'd' },
  source: { type: 'string', short: 's' },
  provider: { type: 'string', short: 'p' },
  edition: { type: 'string', short: 'e' },
  heat: { type: 'string' },
  person: { type: 'string' },
  receipt: { type: 'string' },
  observation: { type: 'string' },
  bib: { type: 'string' },
  station: { type: 'string' },
  state: { type: 'string' },
  old: { type: 'string', short: 'o' },
  note: { type: 'string' },
  actor: { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
  all: { type: 'boolean', short: 'a' },
  detail: { type: 'boolean' },
  override: { type: 'boolean' },
  repeat: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
}

const usage = `帆板重跑航轮 · 岸站观察采集与签收

用法: sail <命令> [选项]
数据目录默认 ./duty-data，也可用 --data 指定；来源与外部接口用 --source / --provider 覆盖。

采集
  sync                     采集赛事资料、岸站观测包、异议与签收件
  source [--edition r1|r2] 只采集赛事资料（含航轮窗、必过点、名单、值班摘要）
  provider                 只采集岸站包与异议、签收回读
  originals [--all]        检查各观察原件能否补取并留档

查询
  heats                    航轮窗与必过点（按次序）
  evidence [筛选]          观察证据（--observation / --station / --heat / --person / --detail）
  passages [筛选]          每轮每人的经过与采用证据（--heat / --person）
  passage --heat --person  一轮一人的经过详情（争议、撤销、跨轮证据都列出）
  signoffs [--receipt R]   各签收件的实际状态与异议锁
  claims                   异议及受影响的签收件
  stations                 岸站部署代、时钟换算与保存期限
  corrections              改号与勘误记录（含原依据摘要）
  handoff --heat --person  交下一环节材料（--out 目录则写 JSON）
  audit [--all]            操作日志

判定（人工钉住观察，不影响其他轮）
  confirm --observation ID [--heat G/Hx --person P]  归属明确时确认
  dispute --observation ID
  revoke  --observation ID
  reopen  --observation ID  清除人工判定，回到自动判定

签收与勘误
  signoff --receipt R | --heat G/Hx --person P
  correct --observation ID --bib N [--receipt R] [--old HEAT]
  errata [--out 目录] [--repeat]  给受影响的已签收件发勘误

通用选项
  --json                   输出 JSON
  --actor 名称             记录操作人
  --note 说明              附注
`

const commands = new Set([
  'sync', 'source', 'provider', 'originals', 'heats', 'evidence', 'passages', 'passage',
  'signoffs', 'claims', 'stations', 'corrections', 'handoff', 'audit', 'confirm', 'dispute', 'revoke', 'reopen',
  'signoff', 'correct', 'errata', 'help'
])

function fail(message, code = 1) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  process.exitCode = code
}

function print(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n')
}

function heatArg(value) {
  return value && value.includes('/') ? value : value
}

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true })
  const command = positionals[0] || 'help'
  if (command === 'help' || values.help) {
    print(usage)
    return
  }
  if (!commands.has(command)) {
    print(usage)
    return fail(`未知命令：${command}`, 2)
  }

  const dataDir = resolve(values.data || process.env.SAIL_DATA || 'duty-data')
  const sail = await openSail({
    dataDir,
    sourceBase: values.source || process.env.SAIL_SOURCE || 'http://127.0.0.1:8700',
    providerBase: values.provider || process.env.SAIL_PROVIDER || 'http://127.0.0.1:8701'
  })
  const actor = values.actor || process.env.SAIL_ACTOR || 'duty'

  if (command === 'source') {
    try {
      const result = await sail.ingestSource({ edition: values.edition })
      if (values.json) return print(result)
      return print(`来源 ${result.edition}：` +
        Object.entries(result.counts).map(([name, count]) => `${name} ${count}`).join('，'))
    } catch (error) {
      return fail(error.message)
    }
  }

  if (command === 'provider' || command === 'sync') {
    try {
      const result = await sail.syncProvider({
        edition: values.edition,
        refresh: command === 'sync' || Boolean(values.edition)
      })
      if (values.json) return print(result)
      const lines = [
        result.source
          ? `来源 ${result.source.edition}：` + Object.entries(result.source.counts).map(([name, count]) => `${name} ${count}`).join('，')
          : '来源资料沿用已采集版本',
        `岸站包 ${result.packs} 个，观测 ${result.observations} 条，异议 ${result.claims} 条，签收件回读 ${result.receipts} 个。`
      ]
      if (result.pendingErrata?.length) {
        lines.push('待发勘误：')
        for (const plan of result.pendingErrata) {
          lines.push(`- ${plan.receipt}（${plan.heatId} ${plan.person}）变化 ${plan.changed.join('、') || '—'}，现缺 ${plan.missing.join('、') || '无'}`)
        }
      }
      return print(lines.join('\n'))
    } catch (error) {
      return fail(error.message)
    }
  }

  if (command === 'originals') {
    let result
    try {
      result = await sail.fetchOriginals()
    } catch (error) {
      return fail(error.message)
    }
    const state = await sail.state()
    const observations = Object.values(state.observations)
      .filter(observation => !values.station || observation.station === values.station)
      .filter(observation => values.all || !['unavailable', 'expired', 'index-only', 'unindexed'].includes(observation.original?.state))
      .filter(observation => !values.observation || observation.id === values.observation)
      .sort((left, right) => left.station.localeCompare(right.station) || String(left.seq).localeCompare(String(right.seq)))
    if (values.json) {
      return print(observations.map(observation => ({
        id: observation.id, photo: observation.photo, original: observation.original
      })))
    }
    const checked = result.filter(item => !values.all || true)
    const header = `已检查 ${result.length} 条，可补取 ${result.filter(item => item.state === 'available').length} 条` +
      (values.all ? '。' : '；已过期或不可领取的用 --all 查看。')
    return print(header + '\n' + renderOriginals(observations))
  }

  if (command === 'heats') {
    const state = await sail.state()
    if (values.json) return print(state.derived?.heats || [])
    return print(renderHeats(state))
  }

  if (command === 'evidence') {
    const state = await sail.state()
    const observations = Object.values(state.observations).filter(observation => {
      if (values.observation && observation.id !== values.observation) return false
      if (values.station && observation.station !== values.station) return false
      if (values.person && !(observation.candidates || []).some(candidate => candidate.person === values.person) &&
        observation.attribution?.person !== values.person) return false
      if (values.heat) {
        const target = heatArg(values.heat)
        if (!(observation.candidates || []).some(candidate => candidate.heatId === target || candidate.heat === target)) return false
      }
      if (values.state && observation.state !== values.state) return false
      return true
    }).sort((left, right) =>
      left.station.localeCompare(right.station) ||
      String(left.seq).localeCompare(String(right.seq)) ||
      left.id.localeCompare(right.id))
    if (values.json) return print(observations)
    if (values.detail && observations.length === 1) return print(renderEvidenceDetail(observations[0]))
    if (values.detail) return print(observations.map(renderEvidenceDetail).join('\n\n'))
    return print(renderEvidence(observations))
  }

  if (command === 'passages') {
    const state = await sail.state()
    const passages = buildPassages(state, {
      heat: heatArg(values.heat),
      person: values.person,
      includeEmpty: true
    })
    if (values.json) return print(passages)
    return print(renderPassages(passages))
  }

  if (command === 'passage') {
    if (!values.heat || !values.person) return fail('passage 需要 --heat 与 --person')
    const state = await sail.state()
    const passage = buildPassage(state, heatArg(values.heat), values.person)
    if (!passage) return fail('没有该航轮人员的经过')
    if (values.json) return print(passage)
    return print(renderPassage(passage))
  }

  if (command === 'signoffs') {
    const state = await sail.state()
    if (values.receipt) {
      const signoff = state.signoffs[values.receipt]
      if (!signoff) return fail('没有该签收件')
      if (values.json) return print({ ...signoff, status: signoffStatus(state, signoff) })
      return print(renderSignoffDetail(state, signoff))
    }
    if (values.json) {
      return print(Object.values(state.signoffs).map(signoff => ({
        ...signoff, status: signoffStatus(state, signoff)
      })))
    }
    return print(renderSignoffs(state))
  }

  if (command === 'stations') {
    const state = await sail.state()
    if (values.json) return print(state.provider?.exports || [])
    return print(renderStations(state))
  }

  if (command === 'corrections') {
    const state = await sail.state()
    if (values.json) return print(Object.values(state.corrections || {}))
    return print(renderCorrections(state))
  }

  if (command === 'claims') {
    const state = await sail.state()
    if (values.json) return print(Object.values(state.claims))
    return print(renderClaims(state))
  }

  if (command === 'audit') {
    const state = await sail.state()
    const events = values.all ? state.audit : state.audit.slice(-40)
    if (values.json) return print(events)
    return print(table(['时间', '类型', '内容'], events.map(event => [
      event.at,
      event.type,
      JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !['at', 'type'].includes(key))))
    ])))
  }

  if (command === 'handoff') {
    if (!values.heat || !values.person) return fail('handoff 需要 --heat 与 --person')
    const state = await sail.state()
    const packet = handoffPacket(state, heatArg(values.heat), values.person)
    if (!packet) return fail('没有该航轮人员的经过')
    if (values.out) {
      const folder = resolve(values.out)
      await mkdir(folder, { recursive: true })
      const file = join(folder, `${packet.heatId.replace('/', '-')}-${packet.person}.json`)
      await writeFile(file, JSON.stringify(packet, null, 2) + '\n', 'utf8')
      return print(`已写出 ${file}`)
    }
    if (values.json) return print(packet)
    return print(renderHandoff(packet))
  }

  if (['confirm', 'dispute', 'revoke', 'reopen'].includes(command)) {
    if (!values.observation) return fail(`${command} 需要 --observation`)
    try {
      const map = { confirm: 'confirmed', dispute: 'disputed', revoke: 'revoked' }
      const observation = command === 'reopen'
        ? await sail.releaseDecision(values.observation, { actor })
        : await sail.recordDecision(values.observation, map[command], {
          actor,
          note: values.note,
          heatId: values.heat && values.heat.includes('/') ? values.heat : null,
          person: values.person || null
        })
      if (values.json) return print(observation)
      return print(`${observation.id} 已记为 ${label(observation.state)}。`)
    } catch (error) {
      return fail(error.message)
    }
  }

  if (command === 'signoff') {
    try {
      const result = await sail.signoff({
        receipt: values.receipt,
        heat: values.heat,
        person: values.person,
        actor,
        note: values.note,
        override: values.override
      })
      if (values.json) return print(result)
      return print(`签收 ${result.signoff.receipt}（${result.signoff.group}/${result.signoff.heat} ${result.signoff.person}）\n` +
        renderPassage(result.passage, { detail: false }) +
        (result.eligibility.eligible ? '' : `\n注意：有未决事项，已按 override 签收。\n${result.eligibility.blockers.join('；')}`))
    } catch (error) {
      return fail(error.message)
    }
  }

  if (command === 'correct') {
    if (!values.observation || !values.bib) return fail('correct 需要 --observation 与 --bib（可加 --receipt）')
    try {
      const result = await sail.correct({
        receipt: values.receipt,
        observation: values.observation,
        bib: values.bib,
        oldHeat: values.old,
        actor,
        note: values.note
      })
      if (values.json) return print(result)
      return print(`改号已提交：${result.correction.id}，${result.correction.observationId} → 号牌 ${values.bib}` +
        (result.correction.previousOwner ? `（原归属 ${result.correction.previousOwner}）` : ''))
    } catch (error) {
      return fail(error.message)
    }
  }

  if (command === 'errata') {
    try {
      const issued = await sail.issueErrata({
        actor,
        outboxDir: values.out ? resolve(values.out) : undefined,
        repeat: values.repeat
      })
      if (values.json) return print(issued)
      if (!issued.length) return print('当前没有需要发出的勘误。')
      return print(issued.map(renderErrata).join('\n\n'))
    } catch (error) {
      return fail(error.message)
    }
  }

  return fail('未知命令', 2)
}

main().catch(error => {
  process.stderr.write((error?.stack || error?.message || String(error)) + '\n')
  process.exitCode = 1
})
