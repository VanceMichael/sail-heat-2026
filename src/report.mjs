import { table } from './util.mjs'
import { buildPassages, buildPassage, evidenceView, windowText } from './model.mjs'
import { signoffStatus, openSignoffClaims } from './store.mjs'

export const STATE_LABELS = {
  confirmed: '确认',
  disputed: '争议',
  unconfirmed: '未确认',
  revoked: '已撤销',
  retired: '已撤出当前资料',
  signed: '已签收',
  challenged: '异议锁定',
  corrected: '已勘误',
  pending: '待签收',
  'pending-original': '待补索引',
  open: '待处理',
  'under-review': '审理中',
  closed: '已结束',
  withdrawn: '已撤回',
  resolved: '已解决',
  rejected: '已驳回',
  received: '已收到',
  issued: '已发出',
  'local-only': '仅本地记录',
  available: '可补取',
  archived: '已留档',
  'index-only': '仅识别索引',
  expired: '已过期',
  unindexed: '未建索引',
  'not-indexed': '未建索引',
  'pending-original': '待补索引',
  unavailable: '不可领取',
  missing: '缺失',
  error: '读取错误',
  used: '已采用',
  retained: '仅留存材料',
  auto: '自动'
}

export function label(value) {
  return STATE_LABELS[value] || value || '—'
}

export function renderHeats(state) {
  const heats = state.derived?.heats || []
  if (!heats.length) return '还没有航轮资料，请先运行 sync。'
  const rows = heats.map(heat => [
    heat.id,
    heat.route,
    windowText(heat),
    heat.boundBy === 'recall' ? `召回 ${heat.recallAt}s` : heat.boundBy === 'next-heat' ? '下一轮起跑' : heat.boundBy === 'fleet' ? '名单截止' : '未封口',
    heat.marks.map(mark => `${mark.order}.${mark.station}/${mark.direction}`).join(' → '),
    heat.fleet.map(member => `${member.person}(${member.bib}) ${member.from}-${member.to}s`).join('  ')
  ])
  return table(['航轮', '路线', '窗口', '边界依据', '必过点（按次序）', '组员'], rows)
}

export function renderEvidence(observations) {
  if (!observations.length) return '没有符合条件的证据。'
  const rows = observations.map(observation => [
    observation.id,
    observation.kind === 'sight' ? '值班摘要' : '设备包',
    `${observation.station}/${observation.seq}`,
    observation.bib,
    observation.rawBib !== observation.bib ? observation.rawBib : '',
    observation.direction,
    evidenceView(observation).clock.text,
    observation.photo || '—',
    label(observation.state),
    observation.attribution
      ? `${observation.attribution.heatId} ${observation.attribution.person} 第${observation.attribution.markOrder}点`
      : observation.ambiguity ? `待定（${observation.ambiguity}）` : '—',
    observation.original ? label(observation.original.state) : '未检查',
    observation.conflicts?.length ? '有' : ''
  ])
  return table(['证据', '来源', '站/流水', '号牌', '原号', '方向', '时钟', '片段', '观察状态', '归属', '原件', '冲突'], rows)
}

export function renderEvidenceDetail(observation) {
  const lines = [`${observation.id}（${observation.kind === 'sight' ? '值班摘要' : '设备包'} ${observation.station}/${observation.seq}）`]
  lines.push(`现场：号牌 ${observation.bib}${observation.rawBib !== observation.bib ? `（原 ${observation.rawBib}）` : ''}，方向 ${observation.direction}，时钟 ${evidenceView(observation).clock.text}`)
  if (observation.offset !== undefined && observation.offset !== null) {
    lines.push(`换算：local ${observation.local} + offset ${observation.offset} ± ${observation.error}`)
  }
  lines.push(`状态：${label(observation.state)}${observation.manual ? `（人工 ${label(observation.manual.state)}，${observation.manual.actor}）` : '（自动）'}`)
  if (observation.original) {
    lines.push(`原件：${label(observation.original.state)}${observation.original.message ? ' — ' + observation.original.message : ''}${observation.original.media ? '（已留档）' : ''}`)
  }
  if (observation.amendments?.length) {
    lines.push(`改号：${observation.amendments.map(item => `${item.source}${item.id ? ' ' + item.id : ''} → ${item.bib}`).join('；')}`)
  }
  if (observation.candidates?.length) {
    lines.push(`候选归属：${observation.candidates.map(candidate => `${candidate.heatId} ${candidate.person} 第${candidate.markOrder}点`).join('；')}`)
  }
  if (observation.ambiguity) lines.push(`待定原因：${observation.ambiguity}`)
  for (const rejection of observation.rejections || []) {
    lines.push(`排除${rejection.heatId ? ' ' + rejection.heatId : ''}：${rejection.detail || rejection.code}`)
  }
  for (const conflict of observation.conflicts || []) {
    lines.push(`冲突（片段 ${conflict.photo}）：${conflict.detail.join('；')}`)
  }
  if (observation.revisions?.length) {
    lines.push('变更：')
    for (const revision of observation.revisions.slice(-10)) {
      lines.push(`- ${revision.at} ${revision.kind} ${revision.from ?? ''} → ${revision.to ?? ''}` +
        (revision.amendments?.length ? `（${revision.amendments.map(item => item.source).join('、')}）` : ''))
    }
  }
  return lines.join('\n')
}

export function renderPassages(passages) {
  if (!passages.length) return '没有符合条件的经过。'
  const rows = passages.map(passage => {
    const revoked = passage.revokedEvidence?.length || 0
    return [
      passage.heatId,
      passage.person,
      passage.bib ?? '—',
      passage.route,
      windowText(passage.window),
      passage.complete ? '可拼齐' : `缺 ${passage.missingOrders.join(',') || '—'}`,
      passage.usedObservationIds.join(',') || '—',
      revoked ? `含撤销/未确认 ${revoked} 条` : '',
      passage.blockers.length ? passage.blockers.join('；') : '—'
    ]
  })
  return table(['航轮', '人员', '号牌', '路线', '窗口', '经过', '采用证据', '备注', '未决'], rows)
}

export function renderPassage(passage, { detail = true } = {}) {
  const lines = []
  lines.push(`${passage.heatId}  ${passage.person}  号牌 ${passage.bib ?? '—'}  路线 ${passage.route}  窗口 ${windowText(passage.window)}（${passage.windowBoundBy}）`)
  const rows = passage.entries.map(entry => [
    entry.order,
    `${entry.station} ${entry.direction}`,
    entry.status === 'used' ? '已采用' : entry.status === 'retained' ? '仅留存' : '缺失',
    entry.used ? entry.used.id : '—',
    entry.used ? entry.used.clock.text : '—',
    entry.used?.original ? label(entry.used.original.state) : '—'
  ])
  lines.push(table(['点', '岸站/方向', '状态', '采用证据', '时钟', '原件'], rows))
  if (!detail) return lines.join('\n')
  lines.push('')
  lines.push(`结论：${passage.complete ? '本轮可拼齐' : '本轮不能拼齐'}`)
  if (passage.blockers.length) lines.push(`未决：${passage.blockers.join('；')}`)
  if (!passage.singleHeat) lines.push('警告：所采用证据跨越不同航轮，不能拼成同一轮材料。')
  for (const entry of passage.entries) {
    if (entry.used) {
      const used = entry.used
      lines.push(`第 ${entry.order} 点采用 ${used.id}（${used.kind === 'sight' ? '摘要' : '设备'} ${used.clock.text}，号牌 ${used.bib}，片段 ${used.photo || '—'}）`)
    }
    for (const expired of entry.expiredOriginals) {
      lines.push(`第 ${entry.order} 点原件 ${expired.id} ${label(expired.original)}${expired.message ? '：' + expired.message : ''}；不以后来重跑的照片补位。`)
    }
    for (const pending of entry.pendingOriginals || []) {
      lines.push(`第 ${entry.order} 点原件 ${pending.id} 尚未见索引（${label(pending.original)}），仍需在可补取时领取。`)
    }
    if (entry.disputed.length) {
      lines.push(`第 ${entry.order} 点争议：${entry.disputed.map(item => `${item.id}（${item.clock.text}）`).join('、')}，待归属复核。`)
    }
    if (entry.unconfirmed.length) {
      lines.push(`第 ${entry.order} 点未确认：${entry.unconfirmed.map(item => `${item.id}（${item.clock.text}）`).join('、')}。`)
    }
    if (entry.revoked.length) {
      lines.push(`第 ${entry.order} 点已撤销：${entry.revoked.map(item => item.id).join('、')}，不计入本轮。`)
    }
    if (entry.withdrawn?.length) {
      lines.push(`第 ${entry.order} 点原轮证据已撤：${entry.withdrawn.map(item => item.id).join('、')}，保留可查但不计入本轮。`)
    }
    if (entry.alternatives.length) {
      lines.push(`第 ${entry.order} 点另有可用证据：${entry.alternatives.map(item => item.id).join('、')}（按次序未采用）。`)
    }
    for (const other of entry.otherPerson) {
      lines.push(`第 ${entry.order} 点另有 ${other.person}（号牌 ${other.bib}）的${label(other.state)}证据 ${other.id}，未计入 ${passage.person}。`)
    }
    for (const other of entry.otherHeat) {
      lines.push(`第 ${entry.order} 点另有 ${other.heatId} 的 ${other.id}（第 ${other.markOrder} 点），不能拼入本轮。`)
    }
  }
  if (passage.orderUncertain.length) {
    lines.push('次序提示：' + passage.orderUncertain.map(item =>
      `第 ${item.order} 点与前一条证据时钟重叠（${item.previousId} / ${item.observationId}）`).join('；'))
  }
  if (passage.revokedEvidence.length) {
    lines.push(`本航轮 ${passage.person} 的撤销或未确认证据：${passage.revokedEvidence.map(item => `${item.id}（${label(item.state)}）`).join('、')}`)
  }
  if (passage.usedObservationIds.length) {
    lines.push(`实际采用证据：${passage.usedObservationIds.join('、')}`)
  }
  return lines.join('\n')
}

export function renderSignoffs(state) {
  const signoffs = Object.values(state.signoffs).sort((left, right) => left.receipt.localeCompare(right.receipt))
  if (!signoffs.length) return '还没有签收件。'
  const rows = signoffs.map(signoff => {
    const claims = openSignoffClaims(state, signoff)
    return [
      signoff.receipt,
      `${signoff.group}/${signoff.heat}`,
      signoff.person,
      label(signoffStatus(state, signoff)),
      signoff.lock ? `锁定于 ${signoff.lock.claim}` : '—',
      signoff.juryState ? label(signoff.juryState) : '—',
      signoff.corrections?.length ? signoff.corrections.map(item => item.id).join(',') : '—',
      signoff.signedAt ? `${signoff.signedAt}（${signoff.signedBy}）` : '—',
      claims.length ? claims.map(claim => `${claim.id} ${label(claim.state)}`).join('；') : '—'
    ]
  })
  return table(['签收号', '航轮', '人员', '实际状态', '异议锁', '裁判回读', '勘误', '签收', '异议'], rows)
}

export function renderSignoffDetail(state, signoff) {
  const lines = [`${signoff.receipt}  ${signoff.group}/${signoff.heat}  ${signoff.person}`]
  lines.push(`状态：${label(signoffStatus(state, signoff))}；裁判回读：${label(signoff.juryState)}`)
  if (signoff.lock) lines.push(`异议锁：${signoff.lock.claim}（${signoff.lock.at}）`)
  if (signoff.baseline) {
    lines.push(`签收依据（${signoff.baseline.at}）：${signoff.baseline.usedObservationIds.join('、') || '无'}`)
    if (signoff.baseline.missingOrders.length) lines.push(`签收时缺失：${signoff.baseline.missingOrders.join('、')}`)
  }
  for (const item of signoff.history || []) lines.push(`- ${item.at} ${item.action}${item.claim ? ' ' + item.claim : ''}${item.actor ? ' ' + item.actor : ''}`)
  return lines.join('\n')
}

export function renderOriginals(observations) {
  const rows = observations.filter(observation => observation.photo).map(observation => [
    observation.id,
    observation.station,
    observation.seq,
    observation.photo,
    observation.kind === 'sight' ? '来源索引' : `岸站 ${observation.boot}`,
    observation.original ? label(observation.original.state) : '未检查',
    observation.original?.shoreState ? label(observation.original.shoreState) : '—',
    observation.original?.status ?? '—',
    observation.original?.media ? '已留档' : '—',
    observation.retainUntil || observation.original?.retainedUntil || '—',
    observation.original?.message || '—'
  ])
  if (!rows.length) return '没有带原件的观察。'
  return table(['证据', '岸站', '流水', '片段', '来源', '可补取', '岸站状态', 'HTTP', '本地留档', '保留至', '说明'], rows)
}

export function renderStations(state) {
  const exports = state.provider?.exports || []
  if (!exports.length) return '还没有岸站部署资料，请先运行 sync。'
  const rows = exports.map(item => [
    item.station,
    item.boot,
    item.offset,
    item.error,
    item.retainUntil || '未公布',
    item.fetchedAt || '—',
    item.file
  ])
  return table(['岸站', '部署代', '时钟修正', '允许误差', '保存至', '最近采集', '观测包'], rows)
}

export function renderClaims(state) {
  const claims = Object.values(state.claims)
  if (!claims.length) return '当前没有异议。'
  const rows = claims.map(claim => [
    claim.id,
    claim.receipt || '—',
    claim.heat || '—',
    claim.person || '—',
    label(claim.state),
    claim.firstSeenAt || '—',
    claim.receipt && state.signoffs[claim.receipt]
      ? label(signoffStatus(state, state.signoffs[claim.receipt]))
      : '—'
  ])
  return table(['异议', '签收号', '航轮', '人员', '状态', '首次见到', '签收件'], rows)
}

export function renderCorrections(state) {
  const items = Object.values(state.corrections || {}).sort((left, right) =>
    String(left.at || left.issuedAt || '').localeCompare(String(right.at || right.issuedAt || '')))
  if (!items.length) return '还没有改号或勘误记录。'
  const rows = items.map(item => item.kind === 'errata'
    ? [
      item.id,
      '勘误',
      item.heatId,
      item.signedPerson,
      item.receipt,
      item.state,
      item.changedObservations.map(change => change.id).join(',') || '—',
      `${item.atSigning.usedObservationIds.length} 条原依据`
    ]
    : [
      item.id,
      '改号',
      item.oldHeat || '—',
      item.previousOwner || '—',
      item.receipt || '—',
      item.state,
      `${item.observationId} → ${item.bib}`,
      item.previousBib ? `原号 ${item.previousBib}` : '—'
    ])
  return table(['编号', '类型', '航轮', '人员', '签收号', '状态', '变化', '说明'], rows)
}

export function renderErrata(errata) {
  const lines = [`勘误 ${errata.id}（签收号 ${errata.receipt}，${errata.heatId}）`]
  lines.push(`原依据：${errata.atSigning.usedObservationIds.join('、') || '无'}`)
  lines.push(`变化观察：${errata.changedObservations.map(item => item.id).join('、') || '无'}`)
  for (const person of errata.people) {
    lines.push(`- ${person.person}${person.isSigned ? '（原签收人）' : '（受影响另一方）'}`)
    for (const passage of person.passages) {
      const tag = passage.heatId === errata.heatId ? '本签收轮' : '相关轮'
      lines.push(`  ${passage.heatId}（${tag}）：${passage.complete ? '可拼齐' : '缺 ' + (passage.missingOrders.join('、') || '—')}`)
      for (const blocker of passage.blockers) lines.push(`    未决：${blocker}`)
    }
  }
  lines.push(`其他签收件继续可用：${errata.unaffectedSignoffs.map(item => `${item.receipt}（${label(item.state)}）`).join('、') || '无'}`)
  return lines.join('\n')
}

export function handoffPacket(state, heatIdValue, person, { at = new Date().toISOString() } = {}) {
  const passage = buildPassage(state, heatIdValue, person)
  if (!passage) return null
  const used = passage.usedObservationIds.map(id => evidenceView(state.observations[id]))
  return {
    packet: 'handoff',
    at,
    heatId: passage.heatId,
    group: passage.group,
    heat: passage.heat,
    route: passage.route,
    window: passage.window,
    windowBoundBy: passage.windowBoundBy,
    person: passage.person,
    bib: passage.bib,
    complete: passage.complete,
    singleHeat: passage.singleHeat,
    usedObservationIds: passage.usedObservationIds,
    usedEvidence: used,
    order: passage.entries.map(entry => ({
      order: entry.order,
      station: entry.station,
      direction: entry.direction,
      status: entry.status,
      observationId: entry.used?.id || null,
      clock: entry.used?.clock || null,
      photo: entry.used?.photo || null,
      original: entry.used?.original || null
    })),
    excluded: passage.entries.flatMap(entry => [
      ...entry.disputed.map(item => ({ observationId: item.id, order: entry.order, reason: 'disputed' })),
      ...entry.unconfirmed.map(item => ({ observationId: item.id, order: entry.order, reason: 'unconfirmed' })),
      ...entry.revoked.map(item => ({ observationId: item.id, order: entry.order, reason: 'revoked' })),
      ...entry.otherPerson.map(item => ({ observationId: item.id, order: entry.order, reason: 'other-person', person: item.person })),
      ...entry.otherHeat.map(item => ({ observationId: item.id, order: entry.order, reason: 'other-heat', heatId: item.heatId }))
    ]),
    missingOrders: passage.missingOrders,
    blockers: passage.blockers,
    expiredUnresolved: passage.expiredUnresolved,
    note: '按合法次序实际采用的证据如下；缺失点不与其他航轮的点拼接。'
  }
}

export function renderHandoff(packet) {
  const lines = [`交下一环节材料：${packet.heatId} ${packet.person}（号牌 ${packet.bib ?? '—'}）`]
  lines.push(`窗口 ${windowText(packet.window)}，路线 ${packet.route}。`)
  lines.push(`结论：${packet.complete ? '本轮证据齐备' : '本轮证据不齐'}`)
  const rows = packet.order.map(entry => [
    entry.order,
    `${entry.station} ${entry.direction}`,
    entry.observationId || '—',
    entry.clock ? entry.clock.text : '—',
    entry.photo || '—'
  ])
  lines.push(table(['点', '岸站/方向', '采用证据', '时钟', '片段'], rows))
  if (packet.excluded.length) {
    lines.push(`未采用：${packet.excluded.map(item => `${item.observationId}（${item.reason}）`).join('、')}`)
  }
  if (!packet.singleHeat) lines.push('警告：证据跨越航轮。')
  if (packet.blockers.length) lines.push(`未决：${packet.blockers.join('；')}`)
  lines.push(packet.note)
  return lines.join('\n')
}

export { buildPassages, buildPassage, evidenceView, windowText, table }
