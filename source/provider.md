# 岸站回放与计圈签收

`GET /shore/exports` 给岸站、部署代、时间锚点和可取观测包。 `offset` 是本地秒到裁判秒的修正量，`error` 给允许误差，方向按航线的每一必经点解释。包为 gzip JSON Lines，每个对象有 `station, boot, seq, local, bib, direction, photo`。照片可通过附带路径取得；410 表明回放已清除。旧和新观测可以同在一个包中。
`GET /jury/claims` 给现场异议和受影响签收件。 `POST /jury/corrections` 接签收号、观察号、新归属与旧航轮，返回是否已收到。活动中的异议状态由 `GET /jury/receipts` 回读。
演练 `before-recall`，`recalled`，`ruling` 分别给判罚前、召回及改号后、回读。航轮和方向明细见资料格式。

sight 是赛事值班导出的旧统一时钟摘要，回放里的 local 只适用对应站次公布的 offset。若旧纸面摘要与新校准的设备包冲突，保留两种证据，待归属复核。S 区图仍可从原始值班接口按卷索取，T 的保留条件另行查询。

合成航轮的召回事务在裁判时钟第 60 秒生效，旧轮终点与重跑起点共用该边界。若修时后的误差范围跨过 60 秒，需呈现两边的可能归属。
