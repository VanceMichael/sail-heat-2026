import { join } from 'node:path'
import { atomicWriteJson, nowIso, readJsonIfPresent, shortHash, stableStringify, withFileLock } from './util.mjs'
import {
  OPEN_CLAIM_STATES, amendFor, buildHeats, buildPassages, entryClock, evidenceView,
  liveObservationSignature, observationConcerns, refreshAttributions
} from './model.mjs'
import { decodeRows } from './source-client.mjs'

export const STATE_VERSION = 2

export class StoreError extends Error {
  constructor(message, code = 'STORE_ERROR') {
    super(message)
    this.code = code
  }
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: { edition: null, etag: null, fetchedAt: null, streams: {}, amend: [] },
    provider: { lastSyncedAt: null, exports: [], packs: [], stage: null },
    observations: {},
    signoffs: {},
    claims: {},
    corrections: {},
    localReassignments: [],
    audit: []
  }
}

export function openStore(directory) {
  return {
    directory,
    statePath: join(directory, 'state.json'),
    async read() {
      const state = await readJsonIfPresent(this.statePath, null)
      if (!state) return emptyState()
      if (!Array.isArray(state.localReassignments)) state.localReassignments = []
      return state
    },
    async write(state) {
      await atomicWriteJson(this.statePath, state)
    },
    async mutate(task) {
      return withFileLock(directory, async () => {
        const state = await this.read()
        const result = await task(state)
        await this.write(state)
        return result
      })
    }
  }
}

export function audit(state, event) {
  state.audit.push({ at: nowIso(), ...event })
  if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000)
}

export function observationId(kind, fields) {
  return `${kind}:${shortHash(stableStringify(fields), 20)}`
}

export function upsertObservation(state, observation) {
  const existing = state.observations[observation.id]
  if (existing) {
    const merged = {
      ...existing,
      ...observation,
      bib: existing.bib,
      manual: existing.manual,
      revisions: existing.revisions || [],
      corrections: existing.corrections || [],
      original: existing.original || observation.original || null,
      createdAt: existing.createdAt,
      firstSeenAt: existing.firstSeenAt || existing.createdAt
    }
    state.observations[observation.id] = merged
    return { observation: merged, created: false }
  }
  const created = {
    pinned: false,
    manual: null,
    revisions: [],
    corrections: [],
    original: null,
    firstSeenAt: observation.observedAt || nowIso(),
    createdAt: nowIso(),
    ...observation
  }
  state.observations[observation.id] = created
  return { observation: created, created: true }
}

export function ingestSource(state, source, { edition, at = nowIso() } = {}) {
  state.source = {
    ...state.source,
    edition: edition || state.source.edition,
    fetchedAt: at,
    streams: {
      starts: decodeRows('starts', source.starts || []),
      marks: decodeRows('marks', source.marks || []),
      fleet: decodeRows('fleet', source.fleet || []),
      sight: decodeRows('sight', source.sight || []),
      issued: decodeRows('issued', source.issued || [])
    },
    amend: decodeRows('amend', source.amend || []),
    etag: source.etag || state.source.etag
  }
  const seen = new Set()
  for (const row of state.source.streams.sight) {
    const id = observationId('sight', { station: row.station, seq: row.seq, photo: row.media })
    seen.add(id)
    const observation = {
      id,
      kind: 'sight',
      station: row.station,
      seq: String(row.seq),
      local: Number(row.clock),
      rawBib: String(row.bib),
      bib: String(row.bib),
      direction: row.direction,
      photo: row.media,
      sourceEdition: edition,
      observedAt: at,
      clock: {
        from: Number(row.clock),
        to: Number(row.clock),
        exact: true,
        basis: 'sight-index',
        offset: null,
        error: null
      }
    }
    const current = state.observations[id]
    if (current?.manual?.state === 'revoked') continue
    const { observation: stored } = upsertObservation(state, observation)
    stored.retired = false
    stored.retiredAt = null
  }
  for (const observation of Object.values(state.observations)) {
    if (observation.kind !== 'sight') continue
    if (seen.has(observation.id)) continue
    if (observation.manual?.state === 'revoked') continue
    observation.retired = true
    observation.retiredAt = observation.retiredAt || at
    if (observation.pinned) continue
  }
  return state
}

export function registerPack(state, pack, exportRow, { at = nowIso() } = {}) {
  const packId = shortHash([exportRow.station, exportRow.boot, exportRow.file, pack.sha256], 20)
  const stored = state.provider.packs.find(item => item.id === packId)
  const exportSnapshot = {
    station: exportRow.station,
    boot: exportRow.boot,
    offset: Number(exportRow.offset),
    error: Number(exportRow.error),
    file: exportRow.file,
    retainUntil: exportRow.retainUntil ?? exportRow.expiresAt ?? null,
    fetchedAt: at
  }
  if (stored) {
    stored.lastSeenAt = at
    stored.export = exportSnapshot
  } else {
    state.provider.packs.push({
      id: packId,
      station: exportRow.station,
      boot: exportRow.boot,
      file: exportRow.file,
      offset: Number(exportRow.offset),
      error: Number(exportRow.error),
      retainUntil: exportSnapshot.retainUntil,
      sha256: pack.sha256,
      problems: pack.problems,
      export: exportSnapshot,
      firstSeenAt: at,
      lastSeenAt: at
    })
    state.provider.exports = mergeExports(state.provider.exports, exportSnapshot)
  }
  const observations = []
  for (const entry of pack.entries) {
    if (typeof entry.station !== 'string' || typeof entry.boot !== 'string' ||
        entry.seq === undefined || entry.local === undefined || entry.bib === undefined) {
      continue
    }
    const id = observationId('pack', {
      station: entry.station, boot: entry.boot, seq: entry.seq, photo: entry.photo || null
    })
    const observation = {
      id,
      kind: 'pack',
      packId,
      station: entry.station,
      boot: entry.boot,
      seq: String(entry.seq),
      local: Number(entry.local),
      rawBib: String(entry.bib),
      bib: String(entry.bib),
      direction: entry.direction,
      photo: entry.photo || null,
      offset: Number(exportRow.offset),
      error: Number(exportRow.error),
      retainUntil: exportSnapshot.retainUntil,
      clock: entryClock(entry, exportRow),
      observedAt: at
    }
    const current = state.observations[id]
    if (current?.manual?.state === 'revoked') continue
    if (current?.pinned) {
      observations.push(id)
      continue
    }
    const { created } = upsertObservation(state, observation)
    if (created) {
      audit(state, {
        type: 'observation-added', id, station: observation.station, seq: observation.seq,
        clock: observation.clock
      })
    }
    observations.push(id)
  }
  return { packId, observations }
}

function mergeExports(current, exportRow) {
  const key = `${exportRow.station}|${exportRow.boot}`
  const others = current.filter(item => `${item.station}|${item.boot}` !== key)
  return [...others, exportRow].sort((left, right) =>
    String(left.station).localeCompare(String(right.station)) || String(left.boot).localeCompare(String(right.boot)))
}

export function applyAmendments(state, at = nowIso()) {
  for (const observation of Object.values(state.observations)) {
    const result = amendFor(state, observation)
    if (observation.bib !== result.bib) {
      observation.revisions = observation.revisions || []
      observation.revisions.push({
        at, kind: 'bib', from: observation.bib, to: result.bib, amendments: result.applied
      })
      observation.bib = result.bib
    }
    observation.amendments = result.applied
  }
}

export function reapply(state, { at = nowIso() } = {}) {
  applyAmendments(state, at)
  refreshAttributions(state, { at })
  return state
}

export function recordDecision(state, observationIdValue, decision, { actor = 'duty', note = null, at = nowIso(), heatId: heatIdValue = null, person = null } = {}) {
  const observation = state.observations[observationIdValue]
  if (!observation) throw new StoreError(`没有观察 ${observationIdValue}`, 'UNKNOWN_OBSERVATION')
  const allowed = ['confirmed', 'disputed', 'revoked', 'unconfirmed']
  if (!allowed.includes(decision)) throw new StoreError(`不支持的决定 ${decision}`, 'BAD_DECISION')
  observation.manual = {
    state: decision,
    actor,
    note,
    at,
    attribution: heatIdValue && person ? { heatId: heatIdValue, person } : observation.manual?.attribution || null
  }
  observation.pinned = true
  observation.revisions = observation.revisions || []
  observation.revisions.push({
    at, kind: 'decision', from: observation.state, to: decision, actor, note,
    attribution: observation.manual.attribution
  })
  audit(state, {
    type: 'observation-decision', id: observationIdValue, decision, actor, note,
    attribution: observation.manual.attribution
  })
  return observation
}

export function releaseDecision(state, observationIdValue, { actor = 'duty', at = nowIso() } = {}) {
  const observation = state.observations[observationIdValue]
  if (!observation) throw new StoreError(`没有观察 ${observationIdValue}`, 'UNKNOWN_OBSERVATION')
  const from = observation.state
  observation.manual = null
  observation.pinned = false
  observation.revisions = observation.revisions || []
  observation.revisions.push({ at, kind: 'decision', from, to: 'auto', actor })
  audit(state, { type: 'observation-decision-cleared', id: observationIdValue, actor })
  return observation
}

export function ensureSignoff(state, { group, heat, person, receipt, actor = 'duty', at = nowIso(), state: signoffState = 'pending' }) {
  if (state.signoffs[receipt]) return state.signoffs[receipt]
  state.signoffs[receipt] = {
    receipt,
    group,
    heat,
    person,
    state: signoffState,
    signedAt: null,
    signedBy: null,
    corrections: [],
    baseline: null,
    lock: null,
    history: []
  }
  audit(state, { type: 'signoff-created', receipt, group, heat, person, actor })
  return state.signoffs[receipt]
}

export function syncIssued(state, { at = nowIso() } = {}) {
  for (const row of state.source.streams.issued || []) {
    let signoff = state.signoffs[row.receipt]
    if (!signoff) {
      signoff = ensureSignoff(state, {
        group: row.group, heat: row.heat, person: row.person, receipt: row.receipt, at
      })
    }
    signoff.group = signoff.group || row.group
    signoff.heat = signoff.heat || row.heat
    signoff.person = signoff.person || row.person
    if (!signoff.signedAt) {
      signoff.state = 'signed'
      signoff.signedAt = at
      signoff.signedBy = 'source-issued'
      signoff.history.push({ at, action: 'sign', actor: 'source-issued', source: 'issued' })
    }
  }
  return state
}

export function resolveGroup(state, { receipt, heat, person } = {}) {
  const issued = (state.source.streams.issued || []).find(row => row.receipt === receipt)
  if (issued) return { group: issued.group, heat: issued.heat, person: person || issued.person }
  const existing = receipt ? state.signoffs[receipt] : null
  if (existing?.group && existing?.heat) {
    return { group: existing.group, heat: existing.heat, person: person || existing.person }
  }
  if (heat && String(heat).includes('/')) {
    const [group, number] = String(heat).split('/')
    return { group, heat: number, person }
  }
  if (heat) {
    const heats = buildHeats(state.source).filter(item => item.heat === heat || item.id === heat)
    const candidates = heats.filter(item => !person || item.fleet.some(member => member.person === person))
    if (candidates.length === 1) return { group: candidates[0].group, heat: candidates[0].heat, person }
    const byGroup = heats.filter(item => !person || item.fleet.some(member => member.person === person))
    if (byGroup.length === 1) return { group: byGroup[0].group, heat: byGroup[0].heat, person }
  }
  return { group: null, heat, person }
}

export function passageSummary(state, heatIdValue, person) {
  return buildPassages(state, { heat: heatIdValue, person, includeEmpty: true })[0] || null
}

export function baselineFor(state, signoff, at = nowIso()) {
  const heatIdValue = `${signoff.group}/${signoff.heat}`
  const passage = passageSummary(state, heatIdValue, signoff.person)
  const evidenceIds = new Set(passage?.usedObservationIds || [])
  for (const entry of passage?.entries || []) {
    for (const item of [entry.used, ...entry.disputed, ...entry.alternatives, ...entry.unconfirmed]) {
      if (item) evidenceIds.add(item.id)
    }
  }
  return {
    at,
    heatId: heatIdValue,
    person: signoff.person,
    usedObservationIds: passage?.usedObservationIds || [],
    complete: passage?.complete || false,
    missingOrders: passage?.missingOrders || [],
    evidence: [...evidenceIds].sort().map(id => {
      const observation = state.observations[id]
      return {
        id,
        signature: observation ? liveObservationSignature(observation) : null,
        station: observation?.station || null,
        seq: observation?.seq || null,
        bib: observation?.bib || null,
        direction: observation?.direction || null,
        clock: observation ? evidenceView(observation).clock : null,
        state: observation?.state || null,
        photo: observation?.photo || null
      }
    }),
    evidenceSignatures: Object.fromEntries([...evidenceIds].sort().map(id => [
      id, state.observations[id] ? liveObservationSignature(state.observations[id]) : null
    ]))
  }
}

export function stampBaselines(state, { at = nowIso() } = {}) {
  for (const signoff of Object.values(state.signoffs)) {
    if (!signoff.baseline && ['signed', 'corrected'].includes(signoff.state)) {
      signoff.baseline = baselineFor(state, signoff, at)
      signoff.history = signoff.history || []
      signoff.history.push({
        at,
        action: 'baseline',
        usedObservationIds: signoff.baseline.usedObservationIds,
        missingOrders: signoff.baseline.missingOrders
      })
    }
  }
  return state
}

export function mergeClaims(state, incoming, { at = nowIso() } = {}) {
  const changes = []
  for (const claim of incoming) {
    const id = String(claim.claim || claim.id || '')
    if (!id) continue
    const existing = state.claims[id]
    const next = {
      ...existing,
      ...claim,
      id,
      firstSeenAt: existing?.firstSeenAt || at,
      lastSeenAt: at
    }
    if (!existing || existing.state !== next.state || existing.receipt !== next.receipt) {
      changes.push({ id, state: next.state, receipt: next.receipt || null })
    }
    state.claims[id] = next
  }
  return changes
}

export function applyClaimLocks(state, { at = nowIso() } = {}) {
  for (const claim of Object.values(state.claims)) {
    const targets = []
    if (claim.receipt && state.signoffs[claim.receipt]) {
      targets.push(state.signoffs[claim.receipt])
    } else {
      for (const signoff of Object.values(state.signoffs)) {
        if (claim.person && signoff.person !== claim.person) continue
        const heatIdValue = `${signoff.group}/${signoff.heat}`
        if (claim.heat && claim.heat !== signoff.heat && claim.heat !== heatIdValue) continue
        if (!claim.heat && !claim.person) continue
        targets.push(signoff)
      }
    }
    for (const signoff of targets) {
      if (OPEN_CLAIM_STATES.includes(claim.state)) {
        if (!signoff.lock) {
          signoff.baseline = signoff.baseline || baselineFor(state, signoff, at)
          signoff.lock = {
            claim: claim.id,
            at,
            heat: claim.heat || signoff.heat,
            person: claim.person || signoff.person
          }
          signoff.history.push({ at, action: 'lock', claim: claim.id })
          audit(state, {
            type: 'signoff-locked', receipt: signoff.receipt, claim: claim.id,
            heat: signoff.heat, person: signoff.person
          })
        }
      } else if (signoff.lock?.claim === claim.id) {
        signoff.history.push({ at, action: 'unlock', claim: claim.id, state: claim.state })
        signoff.lock = null
        audit(state, {
          type: 'signoff-unlocked', receipt: signoff.receipt, claim: claim.id, state: claim.state
        })
      }
    }
  }
}

function relevantObservations(state, heatIdValue, person) {
  return Object.values(state.observations).filter(observation =>
    observationConcerns(observation, heatIdValue, person))
}

function correctionsSince(state, signoff, baseline) {
  const since = baseline?.at || ''
  return Object.values(state.corrections).filter(item =>
    item.kind === 'correction' &&
    String(item.at || '') >= since &&
    (item.receipt === signoff.receipt ||
      (state.observations[item.observationId] &&
        observationConcerns(state.observations[item.observationId], `${signoff.group}/${signoff.heat}`, signoff.person)))
  )
}

export function planErrata(state, { at = nowIso(), ignoreIssued = false } = {}) {
  const plans = []
  for (const signoff of Object.values(state.signoffs)) {
    if (signoff.state !== 'signed' && signoff.state !== 'corrected' && !signoff.baseline) continue
    const heatIdValue = `${signoff.group}/${signoff.heat}`
    const passage = passageSummary(state, heatIdValue, signoff.person)
    const baseline = signoff.baseline || baselineFor(state, signoff, at)
    const relevant = relevantObservations(state, heatIdValue, signoff.person)
    const relevantIds = new Set(relevant.map(observation => observation.id))
    const corrections = correctionsSince(state, signoff, baseline)
    const changedIds = new Set()
    for (const observation of relevant) {
      const before = baseline.evidenceSignatures?.[observation.id]
      if (before !== liveObservationSignature(observation)) changedIds.add(observation.id)
    }
    for (const item of corrections) changedIds.add(item.observationId)
    for (const evidence of baseline.evidence || []) {
      if (!relevantIds.has(evidence.id) && state.observations[evidence.id]) {
        changedIds.add(evidence.id)
      }
    }
    const changed = [...changedIds].map(id => state.observations[id]).filter(Boolean)
    const usedChanged = stableStringify(baseline.usedObservationIds) !== stableStringify(passage?.usedObservationIds || [])
    const missingChanged = stableStringify(baseline.missingOrders) !== stableStringify(passage?.missingOrders || [])
    if (!changed.length && !usedChanged && !missingChanged) continue
    const affectedPeople = new Set([signoff.person])
    for (const observation of changed) {
      for (const candidate of observation.candidates || []) affectedPeople.add(candidate.person)
      if (observation.attribution) affectedPeople.add(observation.attribution.person)
      for (const correction of observation.corrections || []) {
        if (correction.previousOwner) affectedPeople.add(correction.previousOwner)
      }
    }
    for (const item of corrections) if (item.previousOwner) affectedPeople.add(item.previousOwner)
    const people = [...affectedPeople].filter(Boolean).sort().map(person => {
      const passages = buildPassages(state, { person, includeEmpty: true })
      const target = passages.find(item => item.heatId === heatIdValue)
      const before = person === signoff.person ? baseline : null
      const previousPassage = before ? {
        complete: before.complete,
        missingOrders: before.missingOrders,
        usedObservationIds: before.usedObservationIds
      } : null
      return {
        person,
        isSigned: person === signoff.person,
        bib: target?.bib ?? null,
        signedBib: before?.evidence?.find(item => before.usedObservationIds.includes(item.id))?.bib ?? null,
        passages: passages.map(item => ({
          heatId: item.heatId,
          window: item.window,
          complete: item.complete,
          missingOrders: item.missingOrders,
          usedObservationIds: item.usedObservationIds,
          blockers: item.blockers,
          retainedOnly: item.retainedOnly || []
        })),
        current: target ? {
          complete: target.complete,
          missingOrders: target.missingOrders,
          usedObservationIds: target.usedObservationIds,
          blockers: target.blockers
        } : null,
        atSigning: previousPassage
      }
    })
    const changedView = changed.map(observation => ({
      ...evidenceView(observation),
      relevantNow: relevantIds.has(observation.id),
      previous: baseline.evidence?.find(item => item.id === observation.id) || null,
      signatureBefore: baseline.evidenceSignatures?.[observation.id] ?? null,
      signatureAfter: liveObservationSignature(observation)
    }))
    const fingerprint = shortHash({
      receipt: signoff.receipt,
      heatId: heatIdValue,
      person: signoff.person,
      baselineUsed: baseline.usedObservationIds,
      baselineMissing: baseline.missingOrders,
      used: passage?.usedObservationIds || [],
      missing: passage?.missingOrders || [],
      changed: changedView.map(item => [item.id, item.signatureBefore, item.signatureAfter]).sort()
    }, 20)
    const existing = Object.values(state.corrections).find(item =>
      item.kind === 'errata' && item.fingerprint === fingerprint)
    if (existing && !ignoreIssued) continue
    plans.push({
      fingerprint,
      receipt: signoff.receipt,
      heatId: heatIdValue,
      person: signoff.person,
      baseline,
      corrections: corrections.map(item => ({ id: item.id, observationId: item.observationId, bib: item.bib, previousOwner: item.previousOwner })),
      currentUsed: passage?.usedObservationIds || [],
      currentMissing: passage?.missingOrders || [],
      currentComplete: passage?.complete || false,
      changed: changedView,
      people
    })
  }
  return plans
}

export function signoffStatus(state, signoff) {
  if (signoff.lock) return 'challenged'
  if (signoff.state === 'pending') return 'pending'
  if (signoff.state === 'signed' && (signoff.corrections || []).length) return 'corrected'
  return signoff.state
}

export function openSignoffClaims(state, signoff) {
  const heatIdValue = `${signoff.group}/${signoff.heat}`
  return Object.values(state.claims).filter(claim => {
    if (!OPEN_CLAIM_STATES.includes(claim.state)) return false
    if (claim.receipt) return claim.receipt === signoff.receipt
    return (claim.heat === signoff.heat || claim.heat === heatIdValue) &&
      (!claim.person || claim.person === signoff.person)
  })
}

