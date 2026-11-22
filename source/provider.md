# 岸站回放与计圈签收

`GET /shore/exports` 给岸站、部署代、时间锚点和可取观测包。 `offset` 是本地秒到裁判秒的修正量，`error` 给允许误差，方向按航线的每一必经点解释。包为 gzip JSON Lines，每个对象有 `station, boot, seq, local, bib, direction, photo`。照片可通过附带路径取得；410 表明回放已清除。旧和新观测可以同在一个包中。
`GET /jury/claims` 给现场异议和受影响签收件。 `POST /jury/corrections` 接签收号、观察号、新归属与旧航轮，返回是否已收到。活动中的异议状态由 `GET /jury/receipts` 回读。
演练 `before-recall`，`recalled`，`ruling` 分别给判罚前、召回及改号后、回读。航轮和方向明细见资料格式。
