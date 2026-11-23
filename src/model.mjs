import { shortHash, unique } from './util.mjs'

export const HEAT_SEPARATOR = '/'

export const OPEN_CLAIM_STATES = ['open', 'under-review', 'accepted', 'accepted-in-review', 'challenged']
export function heatId(group, heat) {
  return `${group}${HEAT_SEPARATOR}${heat}`
}

function rowsOf(source, name) {
  if (!source) return []
  if (Array.isArray(source[name])) return source[name]
  if (source.streams && Array.isArray(source.streams[name])) return source.streams[name]
  return []
}

export function buildHeats(sourceRows) {
  const starts = rowsOf(sourceRows, 'starts').map(row => ({
    group: row.group, heat: row.heat, route: row.route, action: row.action, clock: Number(row.clock)
  }))
  const fleet = rowsOf(sourceRows, 'fleet').map(row => ({
    group: row.group, person: row.person, bib: String(row.bib), from: Number(row.from), to: Number(row.to)
  }))
  const fleetEnd = new Map()
  for (const row of fleet) fleetEnd.set(row.group, Math.max(fleetEnd.get(row.group) ?? 0, row.to))
  const byGroup = new Map()
  for (const row of starts) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, [])
    byGroup.get(row.group).push(row)
  }
  const heats = []
  for (const [group, rows] of byGroup) {
    const openings = rows.filter(row => row.action === 'start')
    for (const opening of openings) {
      const recall = rows
        .filter(row => row.action === 'recall' && row.heat === opening.heat && row.clock >= opening.clock)
        .sort((left, right) => left.clock - right.clock)[0]
      const laterStart = openings
        .filter(other => other.heat !== opening.heat && other.clock > opening.clock)
        .sort((left, right) => left.clock - right.clock)[0]
      let to
      let boundBy
      if (recall) {
        to = recall.clock
        boundBy = 'recall'
      } else if (laterStart) {
        to = laterStart.clock
        boundBy = 'next-heat'
      } else if (fleetEnd.has(group)) {
        to = fleetEnd.get(group)
        boundBy = 'fleet'
      } else {
        to = Number.POSITIVE_INFINITY
        boundBy = 'open'
      }
      heats.push({
        id: heatId(group, opening.heat),
        group,
        heat: opening.heat,
        route: opening.route,
        from: opening.clock,
        to,
        boundBy,
        openEnded: boundBy === 'open',
        recallAt: recall ? recall.clock : null,
        startAt: opening.clock,
        fleet: fleet.filter(row => row.group === group)
      })
    }
  }
  heats.sort((left, right) => left.from - right.from || left.id.localeCompare(right.id))
  return heats
}

export function buildRoutes(sourceRows) {
  const routes = new Map()
  for (const mark of rowsOf(sourceRows, 'marks')) {
    if (!routes.has(mark.route)) routes.set(mark.route, [])
    routes.get(mark.route).push({
      route: mark.route, order: Number(mark.order), station: mark.station, direction: mark.direction
    })
  }
  for (const marks of routes.values()) marks.sort((left, right) => left.order - right.order)
  return routes
}

export function windowText(window) {
  if (!window) return '—'
  const to = window.to === null || window.to === undefined || !Number.isFinite(window.to) ? '∞' : window.to
  return `[${window.from}, ${to})`
}

export function clockText(clock) {
  if (!clock || clock.from === null || clock.from === undefined || clock.to === null || clock.to === undefined) return '—'
  return clock.from === clock.to ? `${clock.from}s` : `[${clock.from}, ${clock.to}]s`
}

export function viewClock(clock) {
  return {
    from: clock?.from ?? null,
    to: clock?.to ?? null,
    exact: Boolean(clock && clock.from !== null && clock.from === clock.to),
    text: clockText(clock)
  }
}

export function entryClock(entry, exportRow) {
  if (!exportRow) return { from: null, to: null, exact: false, basis: 'device', offset: null, error: null }
  const offset = Number(exportRow.offset)
  const error = Number(exportRow.error)
  const local = Number(entry.local)
  if (!Number.isFinite(local) || !Number.isFinite(offset) || !Number.isFinite(error)) {
    return { from: null, to: null, exact: false, basis: 'device', offset, error }
  }
  return {
    from: local + offset - error,
    to: local + offset + error,
    exact: error === 0,
    basis: 'device',
    offset,
    error
  }
}

export function clockTouchesHeat(clock, heat) {
  return clock.from !== null && clock.to !== null && clock.from < heat.to && clock.to >= heat.from
}

export function amendFor(state, observation) {
  const applied = []
  let bib = String(observation.rawBib)
  for (const row of state.source?.amend || []) {
    if (row.station === observation.station && String(row.seq) === String(observation.seq)) {
      bib = String(row.bib)
      applied.push({ source: 'source-amend', station: row.station, seq: String(row.seq), bib })
    }
  }
  for (const row of state.localReassignments || []) {
    const target = row.target || {}
    if (target.obs !== observation.id) continue
    bib = String(row.bib)
    applied.push({
      source: 'jury-correction',
      id: row.id,
      station: observation.station,
      seq: String(observation.seq),
      bib,
      scope: 'observation'
    })
  }
  return { bib, applied }
}

function ownersForBib(heat, bib, clock) {
  return heat.fleet.filter(row =>
    row.bib === bib && row.from < heat.to && row.to > heat.from &&
    (clock.from === null || (row.from < clock.to + 1 && row.to > clock.from))
  )
}

function candidateOf(heat, mark, owner) {
  return {
    heatId: heat.id,
    group: heat.group,
    heat: heat.heat,
    route: heat.route,
    markOrder: mark.order,
    station: mark.station,
    direction: mark.direction,
    person: owner ? owner.person : null,
    bib: owner ? owner.bib : null
  }
}

export function attributeObservation(observation, { heats, routes }) {
  const clock = observation.clock
  if (!clock || clock.from === null || clock.to === null) {
    return {
      candidates: [],
      rejections: [{ code: 'clock-unknown', detail: '现场时钟换算缺失，不能归入任何航轮窗' }],
      reason: 'clock-unknown'
    }
  }
  const candidates = []
  const rejections = []
  let touched = false
  for (const heat of heats) {
    if (!clockTouchesHeat(clock, heat)) continue
    touched = true
    const marks = routes.get(heat.route) || []
    const atStation = marks.filter(mark => mark.station === observation.station)
    if (!atStation.length) {
      rejections.push({
        heatId: heat.id, code: 'station-not-in-route',
        detail: `${heat.route} 路线不经过 ${observation.station}`
      })
      continue
    }
    const matching = atStation.filter(mark => mark.direction === observation.direction)
    if (!matching.length) {
      rejections.push({
        heatId: heat.id, code: 'direction-mismatch',
        detail: `${observation.station} 在 ${heat.route} 应为 ${unique(atStation.map(mark => mark.direction)).join('/')} 方向，现场记录为 ${observation.direction}`
      })
      continue
    }
    const owners = ownersForBib(heat, observation.bib, clock)
    if (!owners.length) {
      rejections.push({
        heatId: heat.id, code: 'bib-not-in-heat',
        detail: `号牌 ${observation.bib} 不在 ${heat.id} 的有效参赛名单内`
      })
      continue
    }
    for (const owner of owners) {
      for (const mark of matching) candidates.push(candidateOf(heat, mark, owner))
    }
  }
  if (!touched && !rejections.length) {
    rejections.push({ code: 'outside-heat-windows', detail: '换算后的时钟范围不落在任何已公布航轮窗内' })
  }
  const deduped = []
  const seen = new Set()
  for (const candidate of candidates) {
    const key = `${candidate.heatId}|${candidate.markOrder}|${candidate.person}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
  }
  let reason = null
  if (deduped.length === 0) reason = 'no-candidate'
  else if (deduped.length > 1) {
    const heatIds = unique(deduped.map(candidate => candidate.heatId))
    const orders = unique(deduped.map(candidate => candidate.markOrder))
    if (heatIds.length > 1) reason = 'heat-boundary'
    else if (orders.length > 1) reason = 'mark-ambiguous'
    else if (unique(deduped.map(candidate => candidate.person)).length > 1) reason = 'person-ambiguous'
    else reason = 'multiple-candidates'
  }
  return { candidates: deduped, rejections, reason }
}

function conflictsFor(observations) {
  const groups = new Map()
  for (const observation of observations) {
    if (!observation.photo || observation.retired) continue
    if (!groups.has(observation.photo)) groups.set(observation.photo, [])
    groups.get(observation.photo).push(observation)
  }
  const annotations = new Map()
  const add = (observation, conflict) => {
    if (!annotations.has(observation.id)) annotations.set(observation.id, [])
    annotations.get(observation.id).push(conflict)
  }
  for (const [photo, members] of groups) {
    if (members.length < 2) continue
    for (let index = 0; index < members.length; index++) {
      for (let other = index + 1; other < members.length; other++) {
        const left = members[index]
        const right = members[other]
        if (left.station !== right.station || String(left.seq) !== String(right.seq)) continue
        const codes = []
        const details = []
        if (left.rawBib !== right.rawBib) {
          codes.push('bib')
          details.push(`号牌不一致：${left.kind === 'sight' ? '摘要' : '设备'} ${left.rawBib} / ${right.kind === 'sight' ? '摘要' : '设备'} ${right.rawBib}`)
        }
        if (left.direction !== right.direction) {
          codes.push('direction')
          details.push(`方向不一致：${left.direction} / ${right.direction}`)
        }
        const overlap = left.clock?.from !== null && right.clock?.from !== null &&
          left.clock.from <= right.clock.to && left.clock.to >= right.clock.from
        if (!overlap) {
          codes.push('clock')
          details.push(`时钟不一致：${clockText(left.clock)} / ${clockText(right.clock)}`)
        }
        if (!codes.length) continue
        const record = {
          photo,
          sources: [left.id, right.id],
          codes,
          detail: details,
          note: '旧摘要与新校准的设备包冲突，保留两种证据，待归属复核'
        }
        add(left, record)
        add(right, record)
      }
    }
  }
  return annotations
}

export const ORIGINAL_LOST = ['expired', 'index-only', 'unavailable', 'error']
export const ORIGINAL_PENDING = ['not-indexed', 'unchecked']

export function originalLost(observation) {
  if (!observation.photo) return false
  if (observation.original?.media) return false
  return ORIGINAL_LOST.includes(observation.original?.state)
}

export function originalPending(observation) {
  if (!observation.photo) return false
  if (observation.original?.media) return false
  return ORIGINAL_PENDING.includes(observation.original?.state)
}

export function requiresOriginal(observation) {
  return observation.kind === 'pack' && Boolean(observation.photo)
}export function refreshAttributions(state, { at = new Date().toISOString() } = {}) {
  const heats = buildHeats(state.source)
  const routes = buildRoutes(state.source)
  const context = { heats, routes }
  const observations = Object.values(state.observations || {}).sort((left, right) => left.id.localeCompare(right.id))
  const conflicts = conflictsFor(observations)
  for (const observation of observations) {
    const amendment = amendFor(state, observation)
    const previousBib = observation.bib
    observation.bib = amendment.bib
    observation.amendments = amendment.applied
    const attributed = attributeObservation(observation, context)
    observation.candidates = attributed.candidates
    observation.rejections = attributed.rejections
    observation.ambiguity = attributed.reason
    observation.attribution = attributed.candidates.length === 1 ? attributed.candidates[0] : null
    const pinned = observation.manual?.attribution
    if (pinned) {
      const match = attributed.candidates.find(candidate =>
        candidate.heatId === pinned.heatId && candidate.person === pinned.person)
      if (match) {
        observation.attribution = match
        observation.ambiguity = 'manual-attribution'
      } else {
        observation.attribution = null
        observation.ambiguity = 'manual-attribution-no-match'
      }
    }
    observation.conflicts = conflicts.get(observation.id) || []
    const manual = observation.manual && observation.manual.state !== 'auto' ? observation.manual : null
    let automatic
    if (observation.retired) automatic = 'retired'
    else if (observation.attribution) automatic = 'confirmed'
    else if (attributed.candidates.length > 1 || observation.conflicts.length) automatic = 'disputed'
    else automatic = 'unconfirmed'
    observation.automaticState = automatic
    observation.state = manual ? manual.state : automatic
    if (previousBib !== observation.bib) {
      observation.revisions = observation.revisions || []
      observation.revisions.push({
        at, kind: 'bib', from: previousBib, to: observation.bib, amendments: amendment.applied
      })
    }
    observation.updatedAt = at
  }
  state.derived = {
    generatedAt: at,
    heats: heats.map(heat => ({
      id: heat.id,
      group: heat.group,
      heat: heat.heat,
      route: heat.route,
      from: heat.from,
      to: Number.isFinite(heat.to) ? heat.to : null,
      boundBy: heat.boundBy,
      openEnded: heat.openEnded,
      recallAt: heat.recallAt,
      marks: (routes.get(heat.route) || []).map(mark => ({ ...mark })),
      fleet: heat.fleet.map(member => ({ ...member }))
    }))
  }
  state.updatedAt = at
  return state
}

export function observationConcerns(observation, heatIdValue, person) {
  if (observation.attribution?.heatId === heatIdValue && observation.attribution.person === person) return true
  return (observation.candidates || []).some(candidate => candidate.heatId === heatIdValue && candidate.person === person)
}

function scoreEvidence(observation) {
  const original = observation.original?.state
  const originalScore = observation.original?.media ? 0 : original === 'available' ? 0.05 : 0.2
  const clockScore = observation.clock?.exact ? 0 : 0.1
  const kindScore = observation.kind === 'sight' ? 0.01 : 0
  return originalScore + clockScore + kindScore + (observation.clock?.from ?? 0) / 1e6 + (observation.id > '' ? 0 : 0)
}

function betterEvidence(left, right) {
  const difference = scoreEvidence(left) - scoreEvidence(right)
  if (Math.abs(difference) > 1e-9) return difference < 0
  return left.id.localeCompare(right.id) < 0
}

function sequenceConflicts(previous, candidate) {
  return Boolean(previous) && candidate.clock.from < previous.to
}

function chooseInOrder(orders, poolByOrder) {
  let best = { used: [], uncertain: [] }
  const usedIds = new Set()
  const walk = (index, previous, used, uncertain) => {
    if (index === orders.length) {
      if (used.length > best.used.length) best = { used: [...used], uncertain: [...uncertain] }
      return
    }
    const order = orders[index]
    const candidates = (poolByOrder.get(order) || []).filter(candidate => {
      if (usedIds.has(candidate.id)) return false
      if (previous && candidate.clock.from < previous.clock.from) return false
      return true
    })
    for (const candidate of candidates) {
      const overlaps = sequenceConflicts(previous, candidate)
      usedIds.add(candidate.id)
      used.push({ order, observation: candidate })
      if (overlaps) uncertain.push({ order, previousId: previous.id, observationId: candidate.id })
      walk(index + 1, candidate, used, uncertain)
      if (overlaps) uncertain.pop()
      used.pop()
      usedIds.delete(candidate.id)
    }
    walk(index + 1, previous, used, uncertain)
  }
  walk(0, null, [], [])
  return best
}

export function evidenceView(observation) {
  return {
    id: observation.id,
    kind: observation.kind,
    station: observation.station,
    boot: observation.boot || null,
    seq: observation.seq,
    bib: observation.bib,
    rawBib: observation.rawBib,
    direction: observation.direction,
    local: observation.local,
    offset: observation.offset ?? null,
    error: observation.error ?? null,
    clock: viewClock(observation.clock),
    photo: observation.photo || null,
    state: observation.state,
    automaticState: observation.automaticState,
    manual: observation.manual || null,
    attribution: observation.attribution,
    candidates: observation.candidates || [],
    conflicts: observation.conflicts || [],
    amendments: observation.amendments || [],
    original: observation.original ? {
      state: observation.original.state,
      source: observation.original.source || null,
      status: observation.original.status ?? null,
      checkedAt: observation.original.checkedAt || null,
      message: observation.original.message || null,
      media: observation.original.media || null,
      retainedUntil: observation.original.retainedUntil || null
    } : null,
    photoMissing: observation.kind === 'pack' && !observation.photo,
    unavailableOriginal: originalLost(observation),
    uncheckedOriginal: !observation.original,
    pendingOriginal: originalPending(observation),
    firstSeenAt: observation.firstSeenAt || null
  }
}

export function buildPassage(state, heatIdValue, person) {
  const heats = buildHeats(state.source)
  const routes = buildRoutes(state.source)
  const heat = heats.find(item => item.id === heatIdValue)
  if (!heat) return null
  const marks = routes.get(heat.route) || []
  const observations = Object.values(state.observations || {})
  const fleetRow = heat.fleet.find(row => row.person === person)
  const concerning = observations.filter(observation => observationConcerns(observation, heat.id, person))

  const usable = observation => observation.state === 'confirmed'
  const pool = concerning.filter(observation =>
    usable(observation) &&
    !(observation.kind === 'pack' && originalPending(observation)) &&
    observation.attribution?.heatId === heat.id &&
    observation.attribution.person === person
  )
  const poolByOrder = new Map()
  for (const observation of pool) {
    const order = observation.attribution.markOrder
    if (!poolByOrder.has(order)) poolByOrder.set(order, [])
    poolByOrder.get(order).push(observation)
  }
  for (const list of poolByOrder.values()) list.sort((left, right) => betterEvidence(left, right) ? -1 : 1)

  const orders = marks.map(mark => mark.order)
  const assigned = chooseInOrder(orders, poolByOrder)
  const usedByOrder = new Map(assigned.used.map(entry => [entry.order, entry.observation]))

  const entries = marks.map(mark => {
    const used = usedByOrder.get(mark.order) || null
    const atMark = concerning.filter(observation => {
      const candidateAt = (observation.candidates || []).some(candidate =>
        candidate.heatId === heat.id && candidate.person === person && candidate.markOrder === mark.order)
      const attributedAt = observation.attribution?.heatId === heat.id &&
        observation.attribution.person === person && observation.attribution.markOrder === mark.order
      return candidateAt || attributedAt
    })
    const others = atMark.filter(observation => observation.id !== used?.id)
    const disputed = others.filter(observation => observation.state === 'disputed')
    const unconfirmed = others.filter(observation => observation.state === 'unconfirmed')
    const revoked = others.filter(observation => observation.state === 'revoked')
    const withdrawn = others.filter(observation => observation.state === 'retired')
    const alternatives = others.filter(observation =>
      usable(observation) &&
      !(observation.kind === 'pack' && originalPending(observation)) &&
      observation.attribution?.markOrder === mark.order)
    const otherPerson = atMark
      .filter(observation => observation.attribution &&
        observation.attribution.heatId === heat.id &&
        observation.attribution.person !== person &&
        observation.attribution.markOrder === mark.order)
      .map(observation => ({
        id: observation.id,
        person: observation.attribution.person,
        bib: observation.attribution.bib,
        state: observation.state,
        clock: viewClock(observation.clock)
      }))
    const otherHeat = observations
      .filter(observation => observation.station === mark.station &&
        observation.direction === mark.direction &&
        observation.attribution &&
        observation.attribution.heatId !== heat.id &&
        observation.attribution.person === person)
      .map(observation => ({
        id: observation.id,
        heatId: observation.attribution.heatId,
        markOrder: observation.attribution.markOrder,
        state: observation.state,
        clock: viewClock(observation.clock)
      }))
    const expiredOriginals = atMark
      .filter(observation => originalLost(observation))
      .map(observation => ({
        id: observation.id,
        original: observation.original?.state || 'missing',
        originalShore: observation.original?.shoreState || null,
        message: observation.original?.message || null,
        clock: viewClock(observation.clock)
      }))
    const pendingOriginals = atMark
      .filter(observation => originalPending(observation))
      .map(observation => ({
        id: observation.id,
        original: observation.original?.state || 'unchecked',
        clock: viewClock(observation.clock)
      }))
    const retainedOnly = Boolean(used && originalLost(used))
    const blockers = []
    if (!used) {
      if (disputed.length) blockers.push(`必过点 ${mark.order}（${mark.station}）归属争议未决`)
      else if (expiredOriginals.length) blockers.push(`必过点 ${mark.order}（${mark.station}）原件已过期，经过仍不能确认`)
      else if (pendingOriginals.length) blockers.push(`必过点 ${mark.order}（${mark.station}）原件尚未建索引，待补取`)
      else blockers.push(`必过点 ${mark.order}（${mark.station} ${mark.direction}）没有可用确认证据`)
    } else if (retainedOnly) {
      blockers.push(`必过点 ${mark.order}（${mark.station}）原件已过期，只剩识别索引或已有材料，经过仍不能确认`)
    }
    return {
      order: mark.order,
      station: mark.station,
      direction: mark.direction,
      status: used ? (retainedOnly ? 'retained' : 'used') : 'missing',
      used: used ? evidenceView(used) : null,
      retainedOnly,
      alternatives: alternatives.map(evidenceView),
      disputed: disputed.map(evidenceView),
      unconfirmed: unconfirmed.map(evidenceView),
      revoked: revoked.map(evidenceView),
      withdrawn: withdrawn.map(evidenceView),
      otherPerson,
      otherHeat,
      expiredOriginals,
      pendingOriginals,
      blockers,
      note: retainedOnly
        ? '原件已不可补取：采用签收时已留存的索引材料，不再另行补拍。'
        : expiredOriginals.length
          ? '原件已过期：保留已有材料与仍不能确认的经过，不以后来重跑的照片补位。'
          : null
    }
  })

  const missing = entries.filter(entry => entry.status === 'missing').map(entry => entry.order)
  const usedHeatIds = unique(assigned.used.map(entry => entry.observation.attribution.heatId))
  const revokedOrUnconfirmed = concerning.filter(observation =>
    ['revoked', 'unconfirmed', 'retired'].includes(observation.state))
  const blockers = []
  for (const entry of entries) blockers.push(...entry.blockers)
  if (usedHeatIds.length > 1) blockers.push('所采用证据跨越不同航轮，不能作为同一轮材料')
  const retainedOnly = entries.filter(entry => entry.retainedOnly).map(entry => entry.order)

  const passage = {
    heatId: heat.id,
    group: heat.group,
    heat: heat.heat,
    route: heat.route,
    window: { from: heat.from, to: Number.isFinite(heat.to) ? heat.to : null },
    windowBoundBy: heat.boundBy,
    marks: marks.map(mark => ({ ...mark })),
    person,
    bib: fleetRow ? fleetRow.bib : null,
    entries,
    usedObservationIds: assigned.used.map(entry => entry.observation.id),
    usedHeatIds,
    singleHeat: usedHeatIds.length <= 1,
    complete: missing.length === 0 && assigned.used.length === marks.length && usedHeatIds.length <= 1 && blockers.length === 0,
    missingOrders: missing,
    orderUncertain: assigned.uncertain,
    retainedOnly,
    expiredUnresolved: entries.filter(entry => entry.status === 'missing' && entry.expiredOriginals.length).map(entry => entry.order),
    revokedEvidence: revokedOrUnconfirmed.map(evidenceView),
    blockers: unique(blockers)
  }
  return passage
}

export function buildPassages(state, filter = {}) {
  const heats = buildHeats(state.source)
  const observations = Object.values(state.observations || {})
  const passages = []
  for (const heat of heats) {
    if (filter.heat && heat.id !== filter.heat && heat.heat !== filter.heat) continue
    for (const row of heat.fleet) {
      if (filter.person && row.person !== filter.person) continue
      const relevant = observations.some(observation => observationConcerns(observation, heat.id, row.person))
      if (!relevant && !filter.includeEmpty) continue
      const passage = buildPassage(state, heat.id, row.person)
      if (passage) passages.push(passage)
    }
  }
  return passages.sort((left, right) => left.heatId.localeCompare(right.heatId) || left.person.localeCompare(right.person))
}

export function openClaims(state) {
  return Object.values(state.claims || {}).filter(claim => OPEN_CLAIM_STATES.includes(claim.state))
}

export function claimsForSignoff(state, signoff) {
  const heatIdValue = `${signoff.group}/${signoff.heat}`
  return openClaims(state).filter(claim => {
    if (claim.receipt) return claim.receipt === signoff.receipt
    return claim.heat === signoff.heat || claim.heat === heatIdValue
  }).filter(claim => !claim.person || claim.person === signoff.person || claim.receipt === signoff.receipt)
}

export function signoffEligibility(state, passage) {
  const blockers = [...passage.blockers]
  const related = Object.values(state.signoffs || {}).find(signoff =>
    `${signoff.group}/${signoff.heat}` === passage.heatId && signoff.person === passage.person)
  if (related) {
    const claims = claimsForSignoff(state, related)
    if (claims.length) blockers.push(`该签收件正在异议审理：${claims.map(claim => claim.id).join('、')}`)
  }
  return {
    eligible: passage.complete && passage.singleHeat && blockers.length === 0,
    blockers: unique(blockers)
  }
}

export function liveObservationSignature(observation) {
  return shortHash({
    state: observation.state,
    automaticState: observation.automaticState,
    bib: observation.bib,
    rawBib: observation.rawBib,
    direction: observation.direction,
    clock: observation.clock,
    attribution: observation.attribution,
    candidates: (observation.candidates || []).map(candidate => `${candidate.heatId}|${candidate.person}|${candidate.markOrder}`).sort(),
    conflicts: (observation.conflicts || []).map(conflict => conflict.codes).sort(),
    manual: observation.manual ? { state: observation.manual.state, at: observation.manual.at } : null
  })
}
