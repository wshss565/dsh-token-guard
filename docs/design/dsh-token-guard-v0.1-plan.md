> **⚠️ 历史文档，勿作实现依据**
>
> 本文写于 v0.1 设计阶段，其中若干判断已被实测推翻。保留仅为记录决策过程。
> **现行行为请以 `README.md` 与 `docs/COMPATIBILITY.md` 为准**，以测试代码为最终事实。
>
> 已知与最终实现不符之处：
> - 计价未区分高峰/空闲时段（现已实现双时段，且空闲减半）
> - 「读旧账本再累加」（实际必须从零重建，否则用量成倍膨胀——见README 设计决定第4条）
> - 金额用「分」累加（实际用微元，否则低于 1 分的成本全被抹成 0）
> - 假设 dsh 存在 UI 通知 API（实际不存在，见 COMPATIBILITY）

# dsh-token-guard · v0.1 实现方案

> 目标：把每日 token 用量算准，误差 < 1%。
> 本文含**已验证的真实字段**、模块设计、测试用例与验收清单。

---

## 零、阻塞项已解决：usage 字段实测结果

初版大纲里唯一标"待验证"的usage 字段，**已在本机真实 dsh 数据上确认**。

### 数据来源

本机 `~/.dsh/sessions/<workspace>/<session>/session.v{3,4}.jsonl.zstd`
当前样本：10 个文件、2136 条事件、237 条带 usage 的 `assistant/message`。

### 事件结构

```
顶层: { type, seq, time, data, sourceEventSeqs?, surfaceOp? }
time: 毫秒时间戳
```

### usage 字段（`assistant/message` 事件的 `data.usage`）

```json
{
  "inputTokens": 814,
  "outputTokens": 154,
  "cacheReadTokens": 8320,
  "cacheWriteTokens": 0,
  "totalTokens": 9288,
  "reasoningTokens": 28
}
```

**关键语义（实测确认，务必写进 README）**

`totalTokens = inputTokens + outputTokens + cacheReadTokens`

237/237 条样本**精确匹配**，无一例外。由此得出：

- **`inputTokens` 是净新增输入，不含缓存命中部分**
- 因此 `totalTokens` **不是**当轮实际送进模型的上下文长度
- 计价必须分开算：`cacheReadTokens` 走缓存价，`inputTokens` 走未命中价

**踩坑警告**：如果按 `inputTokens × 单价` 计价，会在缓存命中率高时**严重低估成本**（本机样本里cacheRead 是 inputTokens 的 13 倍）。这是本项目最容易写错的一处。

### 字段可变性

`cacheWriteTokens` 与 `reasoningTokens` 并非每条都有：
- `cacheWriteTokens`：237 条中有 119 条
- `reasoningTokens`：237 条中有 118 条

**缺失必须按 0 处理，禁止抛错。**

### 无法确认的部分（如实记录）

`cacheWriteTokens` 在本机全部为 0，因此**无法判断它是否已计入 `totalTokens`**。
两个假设在现有样本下都成立（237/237）。定价公式里按"已计入"处理，并在 `COST-MODEL.md` 标注此假设，待有非零样本时复核。

### 模型归属

`model/selection` 事件携带权威模型信息：

```json
{ "type": "model/selection", "time": 1788872638622,
  "data": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" } }
```

`assistant/message` 的 `data` 里**没有** model 字段。归因模型必须靠 `model/selection` 的时间序最近匹配，或订阅宿主服务拿当前模型。

**这是 v0.1 的第一个实现任务**，因为账本要按模型分别计价。

---

## 一、发现：官方已有一份用量账本

本机 `~/.dsh/.dshw-usage.json` **已经存在按日聚合的用量记录**：

```json
{
  "date": "2026-10-04",
  "lastBalance": 12.96,
  "history": { "2026-10-03": 0.72, "2026-10-04": 0 },
  "events": [
    { "ts": 1791006004235, "day": "2026-10-03", "model": "deepseek-flash",
      "cost": 0.15567484, "tokens": 524482 }
  ],
  "accounting": { "version": 1, "books": { "...": { "days": { "...": {
      "openingUnits": 1376000000, "lastUnits": 1304000000, "debitUnits": 72000000 } } } } }
}
```

**这个发现直接改变项目定位，必须严肃对待。**

### 差在哪

| 能力 | `.dshw-usage.json` | 本插件 |
|---|---|---|
| 按日聚合 | 有 | 有 |
| 事件明细 | 有（ts/day/model/cost/tokens） | 有（更细：五分类归因） |
| 余额扣减 | 有（`debitUnits`，1e7 缩放） | 不做 |
| **用户可设预算** | 无 | 有 |
| **阈值提醒** | 无 | 有 |
| **多档提醒+ 去重** | 无 | 有 |
| **归因**（钱花在哪） | 无 | 有 |
| 空闲/高峰差异化计价 | 无 | 有 |

### 结论：不是重复造轮子，是补上控制层

`.dshw-usage.json` 是**记账**（记了多少），本插件是**管控**（超了没有、该怎么停）。

两者关系必须写进 README，否则社区会问"官方不是已经统计了吗"。

**建议实现（降低冲突风险）**：
- v0.1 先只读不写 `.dshw-usage.json`
- 若后续要做余额对账，**读它**而不是覆盖它
- 若 `.dshw-usage.json` 已提供足够的按日数据，v0.1 可考虑把它作为**数据源之一**而非自己重新聚合全部历史

**但仍需自建账本**，理由：它的 `events[]` 无 input/output/cache 拆分，无法做归因，也无法验证计价是否正确。

---

## 二、模块设计

### collector.mjs — 采集

```js
// 输入：session/event 流
// 输出：NormalizedUsage[]
export function normalize(evt) {
  const u = evt?.data?.usage
  if (!u) return null                      // 非 assistant/message 或无 usage，静默跳过
  return {
    time: evt.time,                        // 毫秒
    seq: evt.seq,                // 用于去重与排序
    sessionId: evt.sessionId ?? null,
    model: currentModel(),                  // 由 model/selection 状态维护
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),// 缺失 = 0
    total: num(u.totalTokens),
  }
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
```

**三条硬规则**
1. `usage` 缺失 → 返回 null，**不抛错**。会话里大量事件没有 usage。
2. 所有数值字段走 `num()` 兜底。缺字段当0，不当异常。
3. 不修改事件对象本身（只读）。

### ledger.mjs — 按日聚合

**账本必须按 tier 分开累计**，否则无法回答「今天高峰花了多少、空闲花了多少」。

```js
// 惰性日切：无定时器，靠读取时比对日期
export function ensureDay(state, now = Date.now()) {
  const today = localDateStr(now)
  if (state.date === today) return state
  if (state.date) archive(state)        // 写 daily/YYYY-MM-DD.json
  return {
    date: today,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    cost: 0,                // 总花费，阈值判定用这个
    byTier: {               // ★ 按时段分开，用于时段感知提示
      peak:    { cost: 0, turns: 0, tokens: 0 },
      offpeak: { cost: 0, turns: 0, tokens: 0 },
    },
    byModel: {},// ★ 按模型分开，切换模型会清空 KV 缓存
    turns: 0,
    notified: {},            // 档位去重标记
    overLimit: false,
  }
}

export function addTurn(day, r, priced) {
  day.input += r.input; day.output += r.output
  day.cacheRead += r.cacheRead; day.cacheWrite += r.cacheWrite
  day.reasoning += r.reasoning
  day.cost += priced.cost
  day.turns++

  const t = (day.byTier[priced.tier] ??= { cost: 0, turns: 0, tokens: 0 })
  t.cost += priced.cost
  t.turns++
  t.tokens += r.total

  const m = (day.byModel[r.model] ??= { cost: 0, turns: 0, input: 0, output: 0, cacheRead: 0 })
  m.cost += priced.cost; m.turns++
  m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead

  return day
}

export function localDateStr(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`  // 本地时区，非 toISOString
}
```

**三个关键点**

1. **`toISOString()` 会转成 UTC**，跨时区用户的日界会错。必须用本地时区格式化。这是 `dayboundary` 测试的核心断言。
2. **`cost` 用浮点累加会有误差**。日累计量级在 ¥0.01 ~ ¥100，用「分」为整数单位累加，展示时再除以 100。
3. **`byTier` / `byModel` 是时段感知与缓存诊断的基础**。没有它们就无法提示「等 2 小时进空闲时段」。

### 阈值：金额与 token 双轨

用户明确要求「设置每天花费多少钱作为阈值」。因此**金额是一等阈值**，不是附属功能。

```js
// 阈值判定：金额与 token 任一超限即触发
export function evaluateThresholds(day, budget) {
  const costPct  = budget.dailyBudgetCny   > 0 ? (day.cost / budget.dailyBudgetCny) * 100 : 0
  const tokenPct = budget.dailyBudgetTokens > 0
    ? ((day.input + day.output + day.cacheRead) / budget.dailyBudgetTokens) * 100 : 0

  return {
    costPct, tokenPct,
    // 取更高的那个作为判定依据：任一超限都要提醒
    pct: Math.max(costPct, tokenPct),
    breached: costPct >= 100 || tokenPct >= 100,
    // 记录是哪个维度触发的，/budget why 需要
    source: costPct >= tokenPct ? 'cost' : 'token',
  }
}
```

**为什么取 `Math.max` 而不是取金额**：两个阈值是「或」的关系——用户设了 ¥50 和 500k token，哪个先到就提醒哪个。只看金额会导致 token 用量爆了但花费还低时毫无察觉。

**金额阈值的优势**：直接对应用户真正在意的「今天花了多少钱」。token 数是抽象的，金额是具体的。所以**金额阈值应作为推荐的主阈值**，`/budget set50` 默认只设金额。

**双轨配置**

```yaml
config:
  dailyBudgetCny: 50          # 金额阈值，推荐
  dailyBudgetTokens: null     # token 阈值，可选
  thresholds: [50, 80, 100]   # 百分比档位，对两个维度统一
```

三个边界情况必须处理：

| 情况 | 处理 |
|---|---|
| 两个阈值都为 null | `/budget` 提示未设置预算，`evaluate` 返回 pct=0 不触发 |
| 金额已超但 token 未超 | `source: 'cost'`，提醒文案用金额 |
| 用户设了 0 或负数 | Schema 校验拒绝，视为未设置 |

**提醒文案要区分时段**，这是本插件的差异化：

```
今日 ¥32.10 / ¥50（64%）· 空闲时段
  其中空闲 ¥28.40 · 高峰 ¥3.70
  距下一个空闲时段：现在就是
```
vs
```
今日 ¥46.80 / ¥50（94%）· 高峰时段
  当前单价 ¥9/百万（未命中输入）
  距 18:00 进入空闲时段还有 1 小时 12 分，此后可省约 50%
```

第二种文案直接告诉用户「等一等能省一半」，比单纯警告有用得多。



### pricing.mjs — 双时段计价

**这一节已用本机真实数据验证过，不是照抄文档。**

#### 官方计价（DeepSeek 2026-09，元/百万 token）

| 模型 | 缓存命中 | 未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-v4-pro` | 0.30 | 9 | 27 |
| `deepseek-v4-flash` / `deepseek-flash` | 0.04 | 2 | 8 |

**高峰时段**（北京时间）：工作日 9:00–12:00、14:00–18:00
**空闲时段**：其余全部时间（周末、法定节假日全天、非高峰工作日），**单价减半**

#### 计价实现

```js
const PRICING = {
  'deepseek-v4-pro':{ hit: 0.30, miss: 9,  out: 27 },
  'deepseek-v4-flash': { hit: 0.04, miss: 2,  out: 8 },
  'deepseek-flash':{ hit: 0.04, miss: 2,  out: 8 },
}
const PEAK_HOURS = [[9, 12], [14, 18]]      // 北京时间

// 时段判定：内部固定用北京时间（UTC+8），与用户所在时区无关
export function isPeak(ts) {
  const b = new Date(ts + 8 * 3600_000)      // 转成北京时间的 UTC 字段
  const dow = b.getUTCDay()
  if (dow === 0 || dow === 6) return false   // 周末全天空闲
  const h = b.getUTCHours()
  return PEAK_HOURS.some(([s, e]) => h >= s && h < e)
}

// 计价：三段分别计算，再乘时段系数
export function costOf(r, model, ts) {
  const p = PRICING[model] ?? PRICING['deepseek-v4-pro']
  const k = isPeak(ts) ? 1 : 0.5
  const price = {
    hit:  p.hit  * k,
    miss: p.miss * k,
    out:  p.out  * k,
  }
  const cost = (r.cacheRead * price.hit + r.input * price.miss + r.output * price.out) / 1e6
  return {
    cost,
    tier: k === 1 ? 'peak' : 'offpeak',
    unit: { ...price },                        // 记录当时单价，供对账
  }
}
```

#### 三条计价硬规则

1. **必须三段分开算**：`cacheRead` 走 `hit`、`input` 走 `miss`、`output` 走 `out`。合并算或只按 `inputTokens` 计价会偏差数倍——本机样本里 `cacheRead` 是 `inputTokens` 的 13 倍。
2. **时段系数乘在单价上，不是乘在结果上**。两者数学等价，但先乘单价能保留 `unit` 快照便于对账。
3. **`isPeak` 内部固定 UTC+8**，不读系统时区。用 Date 本地方法会随用户时区漂移，导致高峰判定错误。

#### ⚠️ 计价公式的验证边界（如实记录）

**已验证**：拿 `~/.dsh/.dshw-usage.json` 的 5 条事件与真实会话 usage 对账，其中**前两条与本公式精确到分位完全一致（比值 1.0000）**。这证实了三段计价 + 空闲减半的公式正确。

**未能验证 —— 高峰时段**：本机 237 条会话**全部落在空闲时段**（0 条高峰），原因是这些会话都在深夜与周末产生。因此：

- **高峰时段的 `×1` 系数未经实测验证**，仅有官方文档依据
- 高峰单价同样来自文档，未交叉验证
- 待后续有工作日白天使用 dsh 时，补一条高峰对账用例

**另一个已知偏差来源**：官方 `events[]` 的结算粒度比 session 日志更细（`tokens` 达 242万，远超单轮上限），无法用本机这批 session 记录逐条复现。**这是粒度不匹配，不是公式错误**，对账时需按比例聚合后再比。

### 时段差价的实际影响

空闲减半不是小数目。以 `deepseek-v4-pro` 为例，同样一轮 50 万 token 的会话：

| 时段 | 成本 |
|---|---|
| 高峰 | ¥4.50 |
| 空闲 | ¥2.25 |
| 差额 | **¥2.25（50%）** |

因此 `/budget` 的提醒必须**显示当前时段与单价**，并提供「距下一个空闲时段还有多久」。用户在高峰看到预算即将超限时，知道「等 2 小时就半价」比单纯警告更有行动价值。

**这条是本插件的高价值功能点**：时段感知让用户能主动选择何时跑重任务。



### attribution.mjs — 归因

| source | 取值来源 | 可得性 |
|---|---|---|
| `system` | `system/message` + `systemPrompt` 分区字数 | 估算 |
| `tools` | 工具 Schema JSON 长度 | 估算 |
| `history` | 历史消息累计 | 估算 |
| `reasoning` | `usage.reasoningTokens` | **精确** |
| `tool-result` | `tool/result` payload 长度 | 估算 |

**诚实说明**：只有 `reasoning` 是精确值，其余四类是**估算**。dsh 的 usage 不按 source 拆分输入 token，五分类归因无法做到精确。

因此归因在UI 上必须**标注为估算**，README 明确写明。这是 v0.1 验收标准里"五类求和 = 总输入"的**口径修正**：

> v0.1 验收：五类求和 = 总输入 **± 估算误差**，且标注 `estimated: true`。
> 精确拆分列为 v0.2+ 的探索项（可能需要 hook 请求组装过程，代价高）。

---

## 三、测试用例设计

### dayboundary.test.mjs（最高优先，最易错）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 本地 23:59:59.999 | 归入当天 |
| 2 | 本地 00:00:00.000 | 归入次日 |
| 3 | 跨月 01-31 → 02-01 | 归档 + 新账本 |
| 4 | 跨年 12-31 → 01-01 | 归档 + 新账本 |
| 5 | 夏令时切换日 | 不崩溃、不丢数据 |
| 6 | 非 UTC+8 时区（设`TZ=America/New_York`） | 日界按本地算，非 UTC |
| 7 | 时区切换后重读旧账本 | 归档文件不被改写 |
| 8 | 进程跨天不重启 | 下次读取时正确切分 |

用例 6 需要 `TZ` 环境变量注入；用例 7验证归档只写一次。

### ledger.test.mjs

| # | 场景 | 断言 |
|---|---|---|
| 1 | 空账本首次读取 | 惰性创建，不报错 |
| 2 | 连续237 条累加 | 总量 = 逐条之和 |
| 3 | `usage` 缺失事件 | 跳过，计数不增|
| 4 | `cacheWriteTokens` 缺失 | 按 0 处理 |
| 5 | `reasoningTokens` 缺失 | 按 0 处理 |
| 6 | 字段为 `null` | 按 0 处理，不抛错 |
| 7 | 重复 `seq` | 幂等，不重复累加 |
| 8 | 崩溃后重跑 | 最多丢最后一轮，不损坏文件 |
| 9 | 并发写| JSONL 追加不互相覆盖 |

用例 7 用 `seq` 幂等，是因为 session 可resume/replay，同一事件可能重复投递。

### pricing.test.mjs

| # | 场景 | 断言 |
|---|---|---|
| 1 | 缓存命中为主 | 成本远低于全价，验证分三段计价 |
| 2 | 缓存全失效 | 走 `miss` 单价 |
| 3 | 工作日 10:00（北京时间） | `tier === 'peak'`，单价 ×1 |
| 4 | 周六任意时刻 | `tier === 'offpeak'`，单价 ×0.5 |
| 5 | 工作日 08:59 / 09:00 | 边界前者 offpeak、后者 peak |
| 6 | 工作日 12:00 / 14:00 | 午休时段 offpeak |
| 7 | 工作日 18:00 | 转为 offpeak |
| 8 | 未知模型 | 回落到 v4-pro，标注 `estimatedPrice: true` |
| 9 | **官方账本回归（空闲）** | 与 `.dshw-usage.json` 前两条事件精确一致，比值 1.0000 |
| 10 | 高峰计价 | ⚠️ 无本机数据，用构造值断言 + 标注未验证 |

**用例 3–7 的边界必须逐一覆盖**，时段判定是本项目最容易写错的地方。半开区间 `[start, end)` 的边界容易差一位。

**用例 9 已实测通过**：`deepseek-flash` 空闲时段三段计价与官方 cost 精确到分位一致。这是计价公式正确性的最强证据。

**用例 10 必须诚实标注**：本机 237 条会话全部落在空闲时段（0 条高峰），高峰系数仅有文档依据。测试注释里写明「待工作日白天实测补充」，不假装已验证。

**`TZ` 注入要求**：`isPeak` 内部固定 UTC+8，因此**设置 `TZ` 不应影响时段判定**。这本身是一条测试——用 `TZ=America/New_York` 跑一遍全部时段用例，结果必须不变。防止有人后来把 `isPeak` 改成用本地时间。

### threshold.test.mjs（新增）

| # | 场景 | 断言 |
|---|---|---|
| 1 | 只设金额 ¥50，花费 ¥25 | 50% 触发提醒档 |
| 2 | 只设金额，花费 ¥40 | 80% 触发 |
| 3 | 花费 ¥50 | 100% 触发超限，`breached: true` |
| 4 | 同时设 ¥50 与 500k token | 取 `Math.max`，先到者触发 |
| 5 | token 超但金额未超 | `source: 'token'` |
| 6 | 金额超但 token 未超 | `source: 'cost'` |
| 7 | 两个阈值都为 null | `pct === 0`，不触发 |
| 8 | 阈值为 0 或负数 | Schema 拒绝，视为未设置 |
| 9 | 同一档位重复触发 | 第二次不提醒（`notified` 去重） |
| 10 | 跨天后档位复位 | 新账本 `notified` 为空 |
| 11 | 金额浮点累加 | 用整数分累加，无浮点漂移 |
| 12 | 提醒文案含时段与余量 | 空闲时提示「现在就是空闲」，高峰时提示距空闲还有多久 |

用例 9、10 是 v0.2 的核心验收，去重做错会导致每轮刷屏。

用例 12 的文案断言要检查**是否真的给出了可行动建议**，而不只是数字。



### collector.test.mjs

| # | 场景 | 断言 |
|---|---|---|
| 1 | 真实 session.v4.jsonl.zstd | 解析出 237 条 usage |
| 2 | 多帧 zstd | 逐帧解析，不只解首帧 |
| 3 | `model/selection` 时间序| 正确匹配到模型 |
| 4 | 跨文件同 seq | 不误判为重复 |

**用例 2 是踩过的坑**：Node 的 `zstdDecompressSync` 对多帧文件只解第一帧（192KB 文件只出229 字节）。必须逐帧遍历。**这个坑要写进 README**，否则任何人复现都会卡住。

---

## 四、实现顺序

按"每步都能独立验证"排列：

1. **probe（已完成）** — 确认真实字段。本文即产物。
2. **frame reader** — 多帧 zstd 逐帧解析。独立可测，有fixture。
3. **collector** — 归一化 + 模型匹配。
4. **ledger + dayboundary** — 核心，风险最高，测试最密。
5. **pricing** — 分三段计价 + 时段判定。
6. **`/budget` 只读命令** — 串起来跑通真实数据。
7. **attribution** — 估算版，标注清楚。

第 6 步是第一个可演示里程碑：装上插件输入 `/budget` 能看到当日真实消耗。

---

## 五、v0.1 验收清单

发布前逐条打勾，**不满足不发**：

- [ ] 账本 token总量与 dsh UI 展示偏差 < 1%
- [ ] 五类归因求和 = 总输入 ± 估算误差，且 UI 标注 `estimated`
- [ ] `totalTokens = input + output + cacheRead` 假设在 fixture 上 100% 成立
- [ ] 计价按 cacheRead / input / output 三段分别计算
- [ ] 8 个 dayboundary 用例全过，含非 UTC+8 时区
- [ ] `usage` 缺失不抛错，字段缺失按 0
- [ ] 重复 `seq` 幂等
- [ ] 多帧 zstd 逐帧解析
- [ ] **不修改任何请求**，卸载后宿主行为完全一致
- [ ] README 写明：usage 字段实测结构、归因是估算、cacheWrite 假设、与 `.dshw-usage.json` 的关系

---

## 六、已实现并通过测试的部分

`src/pricing.mjs` + `src/threshold.mjs` 已落地，**30/30 测试通过**：

```
node --test "test/**/*.test.mjs"
# tests 30  # pass 30  # fail 0
```

覆盖：时段边界（8:59/9:00、11:59/12:00、17:59/18:00、周末全天）、TZ 无关性、三段计价、官方账本回归、双轨阈值、通知去重与防连弹、微元累加无漂移、总额与分项一致性。

### 实现过程中发现并修复的三个真实缺陷

**1. 金额用「分」累加会系统性低估**

原设计 `costCents = round(cost * 100)`。但 flash 空闲期单轮成本约 ¥0.0001~0.01，**低于 1 分的全部被 `Math.round` 抹成 0**。测试直接暴露：1000 轮 × ¥0.0001 累加结果是 ¥0 而非 ¥0.1。

修复：改用**微元（1e-6 元）整数**累加，全程无浮点误差，最小粒度远低于任何有意义的金额。

**2. 总额与分时段拆分冗余存储，会自相矛盾**

原设计同时存 `costCents`（总额）与 `byTier.peak/offpeak.costCents`（分项）。实跑 `/budget` 渲染时出现：

```
今日 ¥47.00 / ¥50.00      ← 来自 costCents
  其中 空闲 ¥0.00 · 高峰 ¥3.47   ← 来自 byTier
```

两者数据源不同，一旦账本被部分写入或外部修改就会漂移。

修复：**删除总额字段，`costOfDay()` 始终由 `byTier` 推导**。单一数据源从结构上杜绝不一致，并加了断言测试。

**3. 一次冲过多个档位会连弹多条提醒**

原实现遍历档位、返回第一个未通知的。意味着用量从 20% 直接跳到 94% 时，会先弹 50% 档、下一轮再弹 80% 档——**同一次用量跳变产生两条提醒**。

修复：只返回**最高**的待触发档位，并把所有 ≤ 它的档位一并标记为已通知（`skipped` 字段记录被合并的档位，供日志而非打扰用户）。

**这三个缺陷都不是理论推演，是跑起来才暴露的。** 这印证了 v0.1「先证明数据可信」的路线是对的。

---

## 七、风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 归因五分类无法精确 | **高** | 明确标注估算；`reasoning` 精确、其余估算；不假装精确 |
| `cacheWriteTokens` 是否计入 total 无法确认 | 中 | 按已计入处理，`COST-MODEL.md` 标注假设 |
| 计价表随官方调整 | 中 | 带 `pricingVersion`，独立可更新 |
| 宿主事件名变更 | 中 | 能力探测 + 降级；fixture 测试锁定字段 |
| 与 `.dshw-usage.json` 重复造轮子 | 中 | 定位为控制层而非记账层；只读不写它 |
| 多帧 zstd 解析 | 低 | 已解决，写进 README 与测试 |

---

## 七、下一步

**立即可做**：把本文的 probe 脚本整理成 `tools/dump-usage.mjs` 发到仓库——它对社区用户也有用（可自查用量），且是 fixture 生成器。

**需要装 dsh 后做**：确认 `llm/stream` 事件与 `session/event` 的关系。本方案的 collector 基于 `session/event`（已验证存在），但插件运行时的订阅路径未验证。若 `session/event` 只在会话结束后触发，则需要改用 `llm/stream` 实时采集——**这是 v0.1 最后一个待确认项**。

真实采集优先用 `llm/stream`（实时、含 usage），`session/event` 用于回填与校准。两者都接、互为冗余。
