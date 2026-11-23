# 帆板重跑航轮 · 观察采集与签收工具

随场可反复使用的值班工具：把赛事来源、岸站观测包、原件事务和裁判回读采到本地，按航轮窗和必过点次序整理每轮每人的经过，只签收证据齐备且无争议的人，并在资料更新改变已签收件时发可查原依据的勘误。

资料、编号、参与方与历史业务记录全部是合成数据，来自本仓库的本地来源模拟器。

## 运行环境

Node.js 22.23.4，无第三方依赖。

```sh
npm run source     # 赛事资料，默认 127.0.0.1:8700，可用 PORT 调整
npm run provider   # 岸站/裁判演练接口，默认 127.0.0.1:8701，可用 PROVIDER_PORT 调整
npm test           # 来源契约 + 工具行为，自起临时端口与临时数据目录
npm run demo       # 在临时目录跑一遍召回→争议→改号→勘误全流程
```

两版业务记录、取件字段与响应语义见[资料格式](source/formats.md)与[外部接口](source/provider.md)。

## 值班流程

```sh
# 1. 采集：赛事资料、岸站观测包、签收回读与异议
node bin/sail.mjs sync

# 2. 查看航轮窗与必过点（按 marks 次序，不按岸站回传顺序）
node bin/sail.mjs heats
node bin/sail.mjs stations          # 岸站部署代、时钟修正、允许误差、保存期限

# 3. 检查原件能否补取，并就地留档
node bin/sail.mjs originals         # 只列仍可补取或尚未建索引的
node bin/sail.mjs originals --all   # 含已过期、仅索引

# 4. 逐轮查看经过，确认证据齐备且无争议
node bin/sail.mjs passages
node bin/sail.mjs passage --heat G/H2 --person Q

# 5. 签收无争议人员（--receipt 或 --heat/--person）
node bin/sail.mjs signoff --heat G/H1 --person P

# 6. 交下一环节材料（列出合法次序内实际采用的证据）
node bin/sail.mjs handoff --heat G/H2 --person Q --out ./handoff

# 7. 裁判改号后发勘误
node bin/sail.mjs correct --receipt doc1 --observation sight:xxxx --bib 8
node bin/sail.mjs errata --out ./outbox
```

全部命令支持 `--data <目录>`（默认 `./duty-data`）、`--source`、`--provider`、`--json`、`--actor`、`--note`。运行 `node bin/sail.mjs help` 看完整清单。

## 取证规则

**航轮窗。** 由 `starts` 的 start/recall 行推出：下一轮起跑或召回生效时本轮封口，之后到名单截止。窗口左闭右开。召回边界两侧的现场位置不得混用。

**时钟换算。** `sight` 摘要是旧统一时钟，直接取摄像秒；岸站包的 `local` 只适用该站该部署代公布的 `offset`，允许误差 `error` 给出范围：

```
裁判秒 = [local + offset - error, local + offset + error]
```

范围跨过召回边界、或同时落在两轮窗内时，观察保持争议，两边候选归属都列出，需要人工裁定后才进入签收。

**归属。** 观察必须同时满足：时钟范围与航轮窗相交、岸站与方向落在该路线 `marks` 的同一必过点、号牌在窗口内属于该组有效参赛人。三条任一不满足即排除并记录原因。多个候选都有依据时观察保持争议；值班可用 `confirm --observation ID --heat G/Hx --person P` 明确指定候选归属，人工归属同样会进审计日志，`reopen` 可退回自动判定。

**次序与拼齐。** 每轮按 `marks` 次序为每个人从确认证据中选出实际采用的一组。跨轮证据、争议证据、已撤销证据不参与选择；选出的证据只能是同一航轮。多个候选落在同一必过点但次序不合法时，只报告，不拼接。

**原件。** 岸站照片按索引探测：`206/200` 可补取并留档；`410` 说明回放已清除，若此前有留档则记 `已留档`、否则记 `已过期/仅识别索引`；`404` 记 `未建索引`，按待补处理。原件过期后只保留已有材料和仍不能确认的经过，不以后来重跑的照片补位。来源索引的合成媒体与岸站照片都按 sha256 存到 `media/`。

## 签收、异议与勘误

**签收** 只对经过完整、同一轮、无未决异议的人成立。用 `signoff` 时会把当时采用的证据、缺失点与证据签名存成 baseline，之后所有变化都以它为准。确实需要带未决事项先签时用 `--override --note`，操作会进审计日志。

**异议** 来自 `GET /jury/claims`。只锁与该异议指向的签收号或该轮该人对应的签收件，其他组的有效件继续可用。签收件状态以 `signoffs` 的“实际状态”为准，`异议锁定` 明确标出锁在哪个异议上。

**改号** 只改变相应观察的归属，不改变其他观察。`correct` 将改号送裁判接口（`POST /jury/corrections`），收到回执后记入本地，并只重算受影响的轮次。

**勘误** 对每个已签收件，用 baseline 对比当前观察签名、采用点与缺失点。有变化时生成 `outbox/ERR-*.json` 与同名 `.md`，内容包括：

- 原签收依据：签收时间、当时采用的观察、缺失点、每条证据的站次与片段；
- 变化的观察：改号来源、现归属、是否仍争议；
- 受影响人员：原签收人与另一方分别列出每个相关轮的缺口与未决项；
- 其他签收件：明确列出继续可用的件。

重复 `errata` 只发新变化，不发重复勘误；`--repeat` 可重发。

## 查询口径

| 命令 | 说明 |
| --- | --- |
| `heats` | 航轮窗、边界依据、按次序的必过点、组员 |
| `stations` | 岸站部署代、时钟修正、允许误差、保存至 |
| `evidence` | 所有观察：号牌/原号、时钟、片段、观察状态、归属、原件状态、冲突；`--detail` 展开换算、排除原因与变更 |
| `passages` | 每轮每人：可拼齐/缺失点、采用证据、未决事项 |
| `passage` | 单轮单人详情：每点采用、争议、撤销、未确认、跨轮证据 |
| `signoffs` | 各件实际状态（已签收/异议锁定/已勘误/待签收）、裁判回读、勘误号 |
| `claims` | 异议状态及对应签收件 |
| `corrections` | 改号与勘误记录，含原依据条数与变化观察 |
| `originals` | 岸站仍可补取的原件、本地留档、待补索引 |
| `handoff` | 交下一环节的 JSON/文本，含采用次序、排除理由、缺口 |
| `audit` | 采集、判定、签收、改号、勘误的操作日志 |

## 数据目录

```
duty-data/
  state.json        观察、签收、异议、改号、勘误与审计日志
  media/<sha>/      已留档原件（按 sha256 去重）
  outbox/ERR-*      勘误 JSON 与 Markdown
  .lock             单写者文件锁
```

`state.json` 可直接阅读，也可整体备份；同一目录可跨场次沿用。切换资料版（`--edition r1|r2`）会影响后续采集，但历史 observations、签收 baseline 与勘误不会被覆盖，已撤销观察会保留可查。
