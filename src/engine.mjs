import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SourceError, createSourceClient } from './source-client.mjs'
import { ProviderError, createProviderClient } from './provider-client.mjs'
import {
  applyClaimLocks, audit, baselineFor, ensureSignoff, ingestSource, mergeClaims, openSignoffClaims,
  openStore, passageSummary, planErrata, recordDecision, registerPack, reapply,
  releaseDecision, resolveGroup, signoffStatus, stampBaselines, syncIssued
} from './store.mjs'
import { buildHeats, buildPassages, signoffEligibility, windowText } from './model.mjs'
import { atomicWriteJson, nowIso, shortHash, unique } from './util.mjs'
import { storeMedia } from './media.mjs'
import { label } from './report.mjs'

const STREAM_NAMES = ['starts', 'marks', 'fleet', 'sight', 'amend', 'issued']

export class AppError extends Error {
  constructor(message, code = 'APP_ERROR') {
    super(message)
    this.code = code
  }
}

export class Sail {
  constructor({ dataDir, sourceBase, providerBase, fetchImpl, log = () => {} } = {}) {
    this.dataDir = dataDir
    this.source = createSourceClient({ base: sourceBase, fetchImpl })
    this.provider = createProviderClient({ base: providerBase, fetchImpl })
    this.log = log
    this.store = openStore(dataDir)
  }

  async state() {
    return this.store.read()
  }

  async mutate(task) {
    return this.store.mutate(async state => {
      await this.loadSourceIfEmpty(state)
      return task(state)
    })
  }

  async loadSourceIfEmpty(state) {
    if (state.source.streams?.starts?.length) return
    try {
      await this.pullSource(state)
    } catch (error) {
      if (error instanceof SourceError) {
        throw new AppError(`尚未采集来源资料，且无法连接来源：${error.message}`, 'NO_SOURCE')
      }
      throw error
    }
  }

  async fetchStream(name, edition) {
    try {
      return await this.source.stream(name, { edition })
    } catch (error) {
      if (error instanceof SourceError && error.code === 'STREAM') return { rows: [], edition, etag: null }
      throw error
    }
  }

  async pullSource(state, { edition } = {}) {
    const catalog = await this.source.catalog(edition)
    const advertised = Array.isArray(catalog.streams) ? catalog.streams : Object.keys(catalog.streams || {})
    const names = unique([...advertised, ...STREAM_NAMES])
    const collected = {}
    let actualEdition = edition || catalog.edition
    let etag = null
    for (const name of names) {
      const result = await this.fetchStream(name, edition || catalog.edition)
      collected[name] = result.rows || []
      if (result.edition) actualEdition = result.edition
      if (name === 'starts') etag = result.etag
    }
    if (!collected.starts) collected.starts = []
    const fetchedAt = nowIso()
    ingestSource(state, { ...collected, etag }, { edition: actualEdition, at: fetchedAt })
    syncIssued(state, { at: fetchedAt })
    reapply(state, { at: fetchedAt })
    stampBaselines(state, { at: fetchedAt })
    const counts = Object.fromEntries(STREAM_NAMES.map(name => [name, (collected[name] || []).length]))
    audit(state, { type: 'source-ingested', edition: actualEdition, counts })
    return { edition: actualEdition, counts }
  }

  async ingestSource({ edition } = {}) {
    return this.mutate(async state => this.pullSource(state, { edition }))
  }

  async pullProvider(state) {
    const exports = await this.provider.exports()
    state.provider.exports = exports
    state.provider.lastSyncedAt = nowIso()
    let observations = 0
    const packs = []
    for (const exportRow of exports) {
      if (!exportRow.file) continue
      const pack = await this.provider.pack(exportRow.file)
      const registered = registerPack(state, pack, exportRow, { at: nowIso() })
      observations += registered.observations.length
      packs.push({
        file: exportRow.file,
        packId: registered.packId,
        entries: pack.entries.length,
        problems: pack.problems,
        offset: exportRow.offset,
        error: exportRow.error
      })
    }
    reapply(state)
    audit(state, { type: 'provider-pulled', packs: packs.length, observations })
    return { packs: packs.length, observations, exports, detail: packs }
  }

  async pullJury(state) {
    const receipts = await this.provider.receipts()
    for (const receipt of receipts) {
      const existing = state.signoffs[receipt.receipt]
      const resolved = resolveGroup(state, {
        receipt: receipt.receipt,
        heat: receipt.heat,
        person: receipt.person || existing?.person
      })
      if (!existing) {
        const signoff = ensureSignoff(state, {
          group: resolved.group || '',
          heat: resolved.heat,
          person: resolved.person,
          receipt: receipt.receipt,
          actor: 'jury-receipt',
          state: receipt.state || 'signed'
        })
        signoff.signedAt = signoff.signedAt || nowIso()
        signoff.signedBy = 'jury-receipt'
        signoff.juryState = receipt.state || 'signed'
      } else {
        if (resolved.group && !existing.group) existing.group = resolved.group
        if (resolved.heat) existing.heat = resolved.heat
        if (resolved.person) existing.person = resolved.person
        existing.juryState = receipt.state || existing.juryState
        if (receipt.correction) existing.juryCorrection = receipt.correction
      }
    }
    const claims = await this.provider.claims()
    reapply(state)
    stampBaselines(state)
    const changes = mergeClaims(state, claims)
    applyClaimLocks(state)
    return { receipts: receipts.length, claims: claims.length, changes }
  }

  async syncProvider({ edition, refresh = true } = {}) {
    const source = edition || refresh ? await this.ingestSource({ edition }) : null
    return this.mutate(async state => {
      if (!state.source.streams?.starts?.length) await this.pullSource(state)
      const pulled = await this.pullProvider(state)
      let jury
      try {
        jury = await this.pullJury(state)
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        jury = { receipts: 0, claims: 0, changes: [], error: error.message }
      }
      const pendingErrata = planErrata(state).map(plan => ({
        receipt: plan.receipt,
        heatId: plan.heatId,
        person: plan.person,
        changed: plan.changed.map(item => item.id),
        missing: plan.currentMissing
      }))
      const receipts = Object.keys(state.signoffs).length
      return { source, ...pulled, ...jury, receipts, pendingErrata }
    })
  }

  async probeOriginals(state) {
    const results = []
    for (const observation of Object.values(state.observations)) {
      if (!observation.photo) continue
      const previous = observation.original || {}
      if (observation.kind === 'sight') {
        try {
          const media = await this.source.media(observation.photo)
          const stored = await storeMedia(this.dataDir, {
            name: media.id, bytes: media.bytes, type: media.type
          })
          observation.original = {
            state: 'available',
            source: 'source-index',
            status: 200,
            checkedAt: nowIso(),
            message: null,
            media: stored
          }
        } catch (error) {
          if (!(error instanceof SourceError)) throw error
          observation.original = {
            ...previous,
            state: previous.media ? 'archived' : 'unavailable',
            source: 'source-index',
            status: 404,
            checkedAt: nowIso(),
            message: error.message,
            media: previous.media || null
          }
        }
      } else {
        let probe
        try {
          probe = await this.provider.probePhoto(observation.photo)
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error
          probe = { id: observation.photo, state: 'error', status: null, message: error.message }
        }
        if (probe.state === 'available') {
          let stored = previous.media || null
          if (!stored) {
            const photo = await this.provider.photo(observation.photo)
            if (photo.state === 'available') {
              const etagName = String(photo.etag || '').replace(/^"|"$/g, '')
              const displayName = /\.[a-z0-9]+$/i.test(etagName)
                ? etagName
                : /\.[a-z0-9]+$/i.test(observation.photo) ? observation.photo : observation.photo + '.png'
              stored = await storeMedia(this.dataDir, {
                name: displayName, bytes: photo.bytes, type: photo.type
              })
            }
          }
          observation.original = {
            state: 'available',
            source: 'shore',
            status: probe.status,
            checkedAt: nowIso(),
            message: null,
            media: stored,
            etag: probe.etag || null
          }
        } else {
          const message = String(probe.message || '')
          const classified = probe.status === 410
            ? (/索引/.test(message) ? 'index-only' : 'expired')
            : probe.status === 404 ? 'not-indexed' : 'error'
          observation.original = {
            ...previous,
            state: previous.media ? 'archived' : classified,
            source: 'shore',
            shoreState: classified,
            status: probe.status,
            checkedAt: nowIso(),
            message: probe.message || null,
            media: previous.media || null,
            lastAvailableAt: previous.state === 'available'
              ? (previous.checkedAt || null)
              : (previous.lastAvailableAt || null)
          }
        }
      }
      observation.originalCheckedAt = observation.original.checkedAt
      results.push({
        id: observation.id,
        photo: observation.photo,
        state: observation.original.state,
        status: observation.original.status ?? null
      })
    }
    return results
  }

  async fetchOriginals() {
    return this.mutate(async state => this.probeOriginals(state))
  }

  async recordDecision(id, decision, options = {}) {
    return this.mutate(async state => {
      const observation = state.observations[id]
      if (!observation) throw new AppError(`没有观察 ${id}`, 'UNKNOWN_OBSERVATION')
      if (decision === 'confirmed' && !observation.attribution) {
        const chosen = options.heatId && options.person
          ? (observation.candidates || []).find(candidate =>
            candidate.heatId === options.heatId && candidate.person === options.person)
          : null
        if (!chosen) {
          const detail = (observation.candidates || []).length
            ? `候选归属有 ${observation.candidates.length} 个（${observation.candidates.map(candidate =>
              `${candidate.heatId} ${candidate.person} 第${candidate.markOrder}点`).join('；')}），请用 --heat 与 --person 指明，或先用 correct 改号`
            : '该观察没有唯一归属，请先用 correct 改号'
          throw new AppError(`不能直接确认：${detail}`, 'AMBIGUOUS')
        }
      }
      recordDecision(state, id, decision, { ...options, heatId: options.heatId, person: options.person })
      reapply(state)
      return state.observations[id]
    })
  }

  async releaseDecision(id, options = {}) {
    return this.mutate(async state => {
      releaseDecision(state, id, options)
      reapply(state)
      return state.observations[id]
    })
  }

  async signoff({ receipt, heat, person, group, actor = 'duty', note = null, override = false }) {
    return this.mutate(async state => {
      const existing = receipt ? state.signoffs[receipt] : null
      const resolved = resolveGroup(state, {
        receipt,
        heat: heat || (existing ? `${existing.group}/${existing.heat}` : null),
        person: person || existing?.person
      })
      const targetPerson = resolved.person || person || existing?.person
      if (!resolved.group || !resolved.heat || !targetPerson) {
        throw new AppError('签收需要 --receipt 或同时给出 --heat 与 --person', 'SIGNOFF_ARGS')
      }
      const heatIdValue = `${resolved.group}/${resolved.heat}`
      const passage = passageSummary(state, heatIdValue, targetPerson)
      if (!passage) throw new AppError(`没有 ${heatIdValue} 的 ${targetPerson} 经过`, 'NO_PASSAGE')
      let target = existing
      if (!target) {
        const matches = Object.values(state.signoffs).filter(item =>
          `${item.group}/${item.heat}` === heatIdValue && item.person === targetPerson && !item.receipt.startsWith('doc-'))
        target = matches[0] || ensureSignoff(state, {
          group: resolved.group,
          heat: resolved.heat,
          person: targetPerson,
          receipt: `doc-${targetPerson}-${resolved.heat}`,
          actor
        })
      }
      target.group = resolved.group
      target.heat = resolved.heat
      target.person = targetPerson
      const eligibility = signoffEligibility(state, passage)
      if (!eligibility.eligible && !override) {
        throw new AppError(`不能签收：${eligibility.blockers.join('；')}`, 'NOT_ELIGIBLE')
      }
      if (override) audit(state, { type: 'signoff-override', receipt: target.receipt, note: note || null })
      target.state = 'signed'
      target.signedAt = nowIso()
      target.signedBy = actor
      target.baseline = baselineFor(state, target)
      target.history.push({
        at: target.signedAt,
        action: 'sign',
        actor,
        usedObservationIds: target.baseline.usedObservationIds,
        missingOrders: target.baseline.missingOrders,
        note: note || null,
        override
      })
      audit(state, {
        type: 'signoff-signed', receipt: target.receipt, heatId: heatIdValue,
        person: targetPerson, actor, override
      })
      return { signoff: target, passage, eligibility }
    })
  }

  async correct({ receipt, observation: observationIdValue, bib, oldHeat = null, actor = 'jury', note = null }) {
    return this.mutate(async state => {
      const observation = state.observations[observationIdValue]
      if (!observation) throw new AppError(`没有观察 ${observationIdValue}`, 'UNKNOWN_OBSERVATION')
      const previousOwner = observation.attribution?.person ??
        (observation.candidates || []).map(candidate => candidate.person).filter(Boolean)[0] ?? null
      const payload = {
        receipt: receipt || null,
        observation: observationIdValue,
        station: observation.station,
        boot: observation.boot || null,
        seq: observation.seq,
        bib: String(bib),
        oldHeat,
        previousBib: observation.bib,
        previousOwner
      }
      let response
      let delivery = 'sent'
      try {
        response = await this.provider.correction(payload)
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        if (error.code === 'CORRECTION') throw new AppError(`裁判接口未接受改号：${error.message}`, 'CORRECTION')
        delivery = 'queued'
        response = { value: null, status: null }
      }
      const id = response.value?.correction || `local-${shortHash(payload, 12)}`
      const record = {
        id,
        kind: 'correction',
        receipt: receipt || null,
        observationId: observationIdValue,
        station: observation.station,
        boot: observation.boot || null,
        seq: observation.seq,
        bib: String(bib),
        oldHeat,
        previousBib: observation.bib,
        previousOwner,
        state: response.value?.state || (delivery === 'queued' ? 'queued' : 'received'),
        delivery,
        httpStatus: response.status,
        actor,
        note,
        at: nowIso()
      }
      state.corrections[id] = record
      state.localReassignments.push({
        id,
        target: { obs: observationIdValue, station: observation.station, seq: observation.seq },
        bib: String(bib),
        at: nowIso()
      })
      observation.corrections = observation.corrections || []
      observation.corrections.push({
        id,
        bib: String(bib),
        at: nowIso(),
        receipt: receipt || null,
        previousOwner
      })
      reapply(state)
      audit(state, {
        type: 'correction-submitted', id, observation: observationIdValue, bib: String(bib),
        receipt: receipt || null, previousOwner
      })
      return { correction: state.corrections[id], observation: state.observations[observationIdValue] }
    })
  }

  async issueErrata({ actor = 'duty', outboxDir, repeat = false } = {}) {
    return this.mutate(async state => {
      const plans = planErrata(state, { ignoreIssued: repeat })
      const folder = outboxDir || join(this.dataDir, 'outbox')
      if (plans.length) await mkdir(folder, { recursive: true })
      const issued = []
      for (const plan of plans) {
        const signoff = state.signoffs[plan.receipt]
        const id = `ERR-${shortHash([plan.receipt, plan.fingerprint], 10)}`
        const errata = {
          id,
          kind: 'errata',
          fingerprint: plan.fingerprint,
          receipt: plan.receipt,
          heatId: plan.heatId,
          signedPerson: plan.person,
          issuedAt: nowIso(),
          actor,
          state: 'issued',
          heatWindow: (() => {
            const heat = buildHeats(state.source).find(item => item.id === plan.heatId)
            return heat ? { from: heat.from, to: Number.isFinite(heat.to) ? heat.to : null } : null
          })(),
          atSigning: {
            usedObservationIds: plan.baseline.usedObservationIds,
            missingOrders: plan.baseline.missingOrders,
            complete: plan.baseline.complete,
            at: plan.baseline.at,
            evidence: plan.baseline.evidence
          },
          current: {
            usedObservationIds: plan.currentUsed,
            missingOrders: plan.currentMissing,
            complete: plan.currentComplete
          },
          corrections: plan.corrections,
          changedObservations: plan.changed.map(item => ({
            id: item.id,
            station: item.station,
            seq: item.seq,
            bib: item.bib,
            rawBib: item.rawBib,
            direction: item.direction,
            clock: item.clock,
            state: item.state,
            automaticState: item.automaticState,
            attribution: item.attribution,
            candidates: item.candidates,
            amendments: item.amendments,
            conflicts: item.conflicts,
            relevantNow: item.relevantNow,
            previous: item.previous,
            signatureBefore: item.signatureBefore,
            signatureAfter: item.signatureAfter
          })),
          people: plan.people,
          unaffectedSignoffs: Object.values(state.signoffs)
            .filter(item => item.receipt !== plan.receipt)
            .map(item => ({
              receipt: item.receipt,
              heatId: `${item.group}/${item.heat}`,
              person: item.person,
              state: signoffStatus(state, item),
              lock: item.lock
            })),
          note: '其他签收件不受影响，继续可用。'
        }
        state.corrections[id] = errata
        if (signoff) {
          signoff.corrections = signoff.corrections || []
          if (!signoff.corrections.some(item => item.id === id)) signoff.corrections.push({ id, at: errata.issuedAt })
          signoff.history.push({
            at: errata.issuedAt, action: 'errata', id,
            changedObservationIds: errata.changedObservations.map(item => item.id)
          })
        }
        await atomicWriteJson(join(folder, `${id}.json`), errata)
        await writeFile(join(folder, `${id}.md`), renderErrataMarkdown(errata), 'utf8')
        audit(state, {
          type: 'errata-issued', id, receipt: plan.receipt,
          changedObservationIds: errata.changedObservations.map(item => item.id)
        })
        issued.push(errata)
      }
      return issued
    })
  }

  async statusReport() {
    const state = await this.store.read()
    const passages = buildPassages(state, { includeEmpty: true })
    const signoffs = Object.values(state.signoffs).map(signoff => ({
      ...signoff,
      status: signoffStatus(state, signoff),
      openClaims: openSignoffClaims(state, signoff)
    }))
    return { state, passages, signoffs }
  }
}

function renderErrataMarkdown(errata) {
  const lines = []
  lines.push(`# 计圈勘误 ${errata.id}`)
  lines.push('')
  lines.push(`- 签收号：${errata.receipt}`)
  lines.push(`- 航轮：${errata.heatId}${errata.heatWindow ? ' ' + windowText(errata.heatWindow) : ''}`)
  lines.push(`- 原签收人：${errata.signedPerson}`)
  lines.push(`- 发出时间：${errata.issuedAt}（${errata.actor}）`)
  lines.push('')
  lines.push('## 原签收依据')
  lines.push('')
  lines.push(`- 签收时间：${errata.atSigning.at}`)
  lines.push(`- 原采用证据：${errata.atSigning.usedObservationIds.join('、') || '无'}`)
  lines.push(`- 原缺失必过点：${errata.atSigning.missingOrders.length ? errata.atSigning.missingOrders.join('、') : '无'}`)
  for (const evidence of errata.atSigning.evidence) {
    lines.push(`  - ${evidence.id}：${evidence.station}/${evidence.seq} 号牌 ${evidence.bib} ${evidence.direction} ${evidence.clock?.text || ''} 片段 ${evidence.photo || '—'}（${evidence.state}）`)
  }
  lines.push('')
  lines.push('## 变化的观察')
  lines.push('')
  if (errata.corrections?.length) {
    lines.push('裁判改号记录：')
    for (const item of errata.corrections) {
      lines.push(`- ${item.id}：${item.observationId} → 号牌 ${item.bib}${item.previousOwner ? '（原归属 ' + item.previousOwner + '）' : ''}`)
    }
    lines.push('')
  }
  for (const changed of errata.changedObservations) {
    lines.push(`- ${changed.id}：${changed.station}/${changed.seq}，原号牌 ${changed.rawBib}，现号牌 ${changed.bib}，方向 ${changed.direction}，时钟 ${changed.clock?.text || '—'}`)
    if (changed.amendments?.length) {
      lines.push(`  - 改号来源：${changed.amendments.map(item => `${item.source}${item.id ? ' ' + item.id : ''} → ${item.bib}`).join('；')}`)
    }
    if (changed.attribution) {
      lines.push(`  - 现归属：${changed.attribution.heatId} ${changed.attribution.person} 第 ${changed.attribution.markOrder} 点`)
    }
    if (changed.state === 'disputed') lines.push('  - 观察仍有冲突，按争议保留。')
    if (changed.previous) {
      lines.push(`  - 改动前：${changed.previous.state}，号牌 ${changed.previous.bib}，${changed.previous.clock?.text || '—'}`)
    }
  }
  lines.push('')
  lines.push('## 受影响人员')
  lines.push('')
  for (const person of errata.people) {
    lines.push(`### ${person.person}${person.isSigned ? '（原签收人）' : '（受影响另一方）'}`)
    lines.push('')
    for (const passage of person.passages) {
      const sameHeat = passage.heatId === errata.heatId
      lines.push(`- ${passage.heatId}${sameHeat ? '（本签收轮）' : ''} ${windowText(passage.window)}：${passage.complete ? '可拼齐' : '缺 ' + (passage.missingOrders.join('、') || '—')}`)
      if (passage.usedObservationIds.length) lines.push(`  - 采用：${passage.usedObservationIds.join('、')}`)
      for (const blocker of passage.blockers) lines.push(`  - 未决：${blocker}`)
    }
    if (person.atSigning) {
      lines.push(`- 签收当时：${person.atSigning.complete ? '可拼齐' : '缺 ' + (person.atSigning.missingOrders.join('、') || '—')}`)
    }
    lines.push('')
  }
  lines.push('## 其他签收件')
  lines.push('')
  lines.push('以下签收件不受本勘误影响，继续可用：')
  for (const item of errata.unaffectedSignoffs) {
    lines.push(`- ${item.receipt}（${item.heatId} ${item.person}）：${label(item.state)}${item.lock ? '，锁定于 ' + item.lock.claim : ''}`)
  }
  lines.push('')
  lines.push(errata.note)
  lines.push('')
  return lines.join('\n')
}

export async function openSail(options) {
  return new Sail(options)
}

