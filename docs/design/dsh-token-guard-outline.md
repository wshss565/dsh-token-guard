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

# dsh-token-guard

>给 DeepSeek Harness（`dsh`）用的每日 token 预算管控：设上限、超阈值提醒、每天自动清零。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-534AB7?style=flat-square)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-0F6E56?style=flat-square)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-v0.1.x-FAEEDA?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![status](https://img.shields.io/badge/status-developer--preview-BA7517?style=flat-square)](./docs/COMPATIBILITY.md)

---

## 一句话定位

`dsh-token-guard` 统计 dsh 每一次模型请求消耗的 token，按日累计到本地账本；超过用户设定的阈值时，以斜杠命令回执、设置页余量环和浏览器通知三种方式提醒。

**它不替你省 token，它让你知道钱花在哪、花了多少、什么时候该停。**

---

## 定位收窄说明（重要）

本文档范围相比初版有实质收窄。初版设想的是"逐轮动态降档 + 硬熔断"，现改为**纯观测 + 阈值提醒**。

这是一个诚实的降级，理由如下：

| 维度 | 纯提醒（本版） | 动态降档 + 熔断 |
|---|---|---|
| 实现风险 | 低。只读观测，不改写请求 | 高。改写 `options` 可能改变输出质量 |
| 用户信任 | 装了不影响原有行为 | 装了行为会变，需要用户信任插件 |
| 可靠性要求 | 中。账本差一点只是提醒不准 | 高。账本不准会导致误熔断，冤枉钱 |
| v0.1 可交付性 | 可以 | 不行，必须先解决记账准确性 |

**核心取舍**：熔断建立在"账本足够准"之上。v0.1 连账本准不准都还没验证（验收标准是误差 < 1%），就先做熔断是本末倒置。

降档与熔断作为 v0.4 的可选扩展保留，`policy` 接口预留但不启用。

---

## 问题：每日花超了却不知道

dsh 默认配置偏向能力优先，叠加三项后长会话成本容易失控：

| 因素 | 默认值 | 后果 |
|---|---|---|
| 上下文窗口 `W` | 1,000,000 | 阈值算出来极其宽松 |
| 单次输出上限 `O` | 256,000 | 吃掉压缩阈值的计算空间 |
| 压缩触发阈值 | `floor(min(W×0.8, W−O−65536))` ≈ **678,464** | 要聊到 68 万 token 才压缩 |
| `reasoningEffort` | `high` | 每轮思维链全量带入后续请求 |
| `tool-result-pruner` | 8192 / 4096 / 1024 字符，**仅在压缩后生效** | 阈值前工具输出无上限累积 |

结论：**成本主要在输入侧，不在输出侧**。每轮都重新携带系统提示词 + 工具 Schema + 完整历史 + 上一轮思维链。

按 DeepSeek 2026-09 计价，`deepseek-v4-pro` 上下文累积到 50 万 token 时：

- 缓存命中 90% → 本轮输入约 **¥0.59**
- 缓存全部失效 → 本轮输入约 **¥4.50**

同一轮，**7 倍以上差距**。缓存命中率因此必须是一等指标。

---

## 核心概念：一天怎么算

这是本插件最容易做错的地方，先定死。

**预算日界：本地时区的自然日 00:00:00 → 23:59:59.999**

选本地时区而非北京时间，理由是"每日"对用户的心智模型是"我今天花的钱"，跟手机 app 的日结一致。用北京时间会在跨时区使用者的午夜产生"额度突然重置"的错位感。

**计价时段：按北京时间判断高峰/空闲**（DeepSeek 官方规则：工作日 9:00–12:00、14:00–18:00 为高峰，其余减半）

这两个时区**故意不同**。计价规则由官方定义，不能改；日界由用户体验定义，也不该改。代价是跨时区用户的日界与计价日界错位，最多影响"当日成本"的计价精度，不影响"当日用量"的事实统计。文档中明确标注此行为。

### 日切处理

三条规则：

1. **惰性重置**：读账本时发现 `ledger.date !== today()`，先归档再开新的一天。无需定时器，进程跨天不会漏切。
2. **归档不删除**：每日账本写成独立文件 `daily/YYYY-MM-DD.json`，历史可查、可导出。
3. **日切不重置累计历史**：保留 `allTime` 汇总，避免用户以为"换个地方用就不算"。

---

## 核心能力

### 1. 每日账本（daily ledger）

每轮请求记录一条，聚合口径如下：

```
input          总输入 token
 ├─ cached     其中缓存命中
 ├─ uncached   其中缓存未命中
output         输出 token
reasoning      思维链 token（若 usage 可分）
cost           按计价表折算，标注所用计价时段
perTurn[]      归因明细
```

**归因source 五分类**：`system` / `tools` / `history` / `reasoning` / `tool-result`。五类求和应等于总输入 token（这是账本准确性的自检项）。

### 2. 阈值提醒（thresholds）

支持多档，默认三档：

| 档位 | 默认 | 触发行为 |
|---|---|---|
| 提醒 | 50% | 会话内回执一次 + 余量环变黄 |
| 警告 | 80% | 回执 + 余量环变橙 + 浏览器通知 |
| 超限 | 100% | 回执 + 余量环变红 + 浏览器通知 + 记录超限事件 |

**去重规则（关键）**：每档每个预算日只提醒一次。同一档在 `daily/YYYY-MM-DD.json` 里打 `notified` 标记。

不做去重的后果很具体：一次长任务几十轮，每轮都弹"已用 50%"，用户会立刻关掉通知，然后这个功能就永久失效了。**提醒的价值和频次成反比。**

超限后继续使用只记账不阻断，账本记 `overLimit: true`，`/budget` 查询时明确显示"今日已超限 ¥X"。

### 3. 三种提醒通道

| 通道 | 实现 | 适用 |
|---|---|---|
| 斜杠命令回执 | `ctx.commands.register` | 主动查询，最可靠 |
| 设置页余量环 | `ctx.slots.inject('settings.section', ...)` | 随时可见 |
| 浏览器通知 | Client 侧 Notification API | 跨窗口感知 |

**主通道是斜杠命令**：`/budget` 永远能查到准确数值。通知与余量环是辅助，因为它们可能被浏览器权限拦住、可能被用户关掉。

### 4. 预算设置

```
/budget                     查询今日用量、余量、档位状态
/budget set 50              设每日 ¥50
/budget set 500k 50         设每日 50 万 token + ¥50 兜底
/budget threshold 40 75 90  自定义提醒档位（百分比）
/budget notify off|quiet|normal  提醒级别
/budget history 7           近 7 天明细
/budget reset               清空今日（误配后救急）
/budget why                 今日花费的归因排序
```

`/budget why` 是最有价值的命令——它把一个数字翻译成"42% 来自 tool-result，主要因为连续 3 次读取 4 万行文件"，而不是丢一堆数字。

---

## 架构

```
dsh 运行时（宿主）
  llm/stream · session/event · commands · webServer
        │← cordis.patch.yml 按 id 覆盖，无侵入
        ▼
dsh-token-guard
  collector      采集每轮 usage
  ledger         按日聚合、惰性日切
  threshold      档位判定 + 去重
  notifier       三通道分发
        ▼
斜杠命令 · 设置页余量环 · 浏览器通知 · JSONL 导出
```

**关键约束**
- **零 fork**。只靠 patch 覆盖与事件订阅，不改宿主源码
- **零硬依赖**。`ctx.get('sessions')` 缺失时降级运行，不阻塞加载
- **只读**。不拦截、不中止、不改写任何请求。卸载后宿主行为完全复原
- **可卸载**。所有监听经 `ctx.effect` 注册

---

## 目录结构

```
dsh-token-guard/
├─ cordis.patch.yml            # 插件入口：insert 本插件
├─ package.json                # dsh.bundle.patch 指向 patch 文件
├─ index.mjs                   # apply(ctx, config) 薄入口
├─ src/
│  ├─ collector.mjs            # llm/stream 订阅，提取 usage
│  ├─ ledger.mjs               # 按日聚合 + 惰性日切 + 归档
│  ├─ attribution.mjs          # 五分类归因
│  ├─ threshold.mjs            # 档位判定 + 去重标记
│  ├─ notifier.mjs             # 三通道分发
│  ├─ pricing.mjs              # 计价表（高峰/空闲）
│  ├─ budget.mjs               # 预算读写与校验
│  └─ commands.mjs             # /budget 系列
├─ client/
│  ├─ index.mjs                # window.__ModuleLoader__.load
│  ├─ budget-ring.mjs          # 余量环
│  └─ notify.mjs               # 浏览器通知
├─ docs/
│  ├─ COMPATIBILITY.md         # 版本矩阵 + 验证日期
│  ├─ COST-MODEL.md            # 计价与归因口径
│  └─ DAY-BOUNDARY.md          # 时区与日切规则
├─ test/
│  ├─ ledger.test.mjs
│  ├─ dayboundary.test.mjs     # 跨日、跨时区、惰性重置
│  ├─ threshold.test.mjs       # 含去重验证
│  └─ fixtures/                # 真实 session 轨迹样本
└─ examples/
   └─ solo.preset.yml          # 个人轻量预设
```

---

## 分期路线

### v0.1 — 记账要准（先证明数据可信）

**交付**：`llm/stream` 订阅、ledger 按日聚合、五分类归因、`/budget` 只读查询。

**验收标准（硬指标）**：
- 真实长会话跑通，账本 token 数与 dsh UI 展示消耗**误差 < 1%**
- 五类 source 求和 = 总输入 **± 估算误差**，且 UI / 导出标注 `estimated: true`
- `total = input + output + cacheRead` 在 fixture 上 100% 成立
- 计价按 cacheRead / input / output **三段分开**计算
- 跨日测试：伪造跨天时间戳，账本正确归档并开新的一天；非 UTC+8 时区日界正确
- **不改任何请求**，卸载后行为与未装插件完全一致

**关于归因的诚实说明**

dsh 的 usage **不按 source 拆分输入 token**，因此五分类归因中只有 `reasoning`（来自 `usage.reasoningTokens`）是精确值，其余四类均为**估算**。UI 与 README 必须明确标注，不得伪装成精确数据。精确拆分需 hook 请求组装过程，代价高，列为 v0.2+ 探索项。

**为什么先做这个**：账本不准，提醒就是错误信息，错误信息比没有信息更糟。

### v0.2 — 阈值与提醒

**交付**：threshold 档位判定、通知去重、`/budget set` / `threshold` / `why` / `history`。

**验收**：
- 每档每日只提醒一次，跨重启不重复
- 超限后继续使用只记账不阻断
- 档位自定义后立即生效
- 提醒通道任一失败不影响其他通道

### v0.3 — 观测面

**交付**：设置页余量环、浏览器通知、`/budget history`、JSONL 导出、`dsh-plugin` topic、兼容性矩阵。

**验收**：
- 新用户按README 10 分钟内跑起来
- `dsh plugin add dsh-token-guard` 一行安装可用
- 通知被浏览器拦截时有降级提示，不静默失败

### v0.4 — 可选：降档与熔断（默认关闭）

**交付**：`policy` 接口落地，`reasoningEffort` 降档、可选硬上限。

**前置条件**：v0.1 账本误差连续稳定 < 1% 达一个发布周期。达不到就不做。

**默认关闭**，需用户在配置中显式开启。开启即意味着插件会改变输出质量，这是用户的知情选择。

---

## 安装

```bash
dsh plugin add dsh-token-guard
```

首次使用设置预算：

```
/budget set 50
/budget
```

本地开发：

```bash
dsh plugin --profile plugin-dev add link:./dsh-token-guard
dsh --profile plugin-dev --dump-config      # 确认配置层已合入
dsh --profile plugin-dev
```

---

## 配置

```yaml
# cordis.patch.yml
- insert:
  - id: token-guard
    name: dsh-token-guard
    config:
      dailyBudgetCny: 50
      dailyBudgetTokens: null
      thresholds: [50, 80, 100]
      dayBoundary: local            # local | fixed-utc
      pricingVersion: '2026-09'
      enforce: false                # v0.4 之前恒为 false
```

Schema 校验，窄且有文档。`enforce` 字段从 v0.1 就存在但恒为 `false`，为 v0.4 预留。

---

## 数据与文件

```
$DSH_HOME/token-guard/
├─ budget.json              # 用户配置（预算、档位）
└─ daily/
   ├─ 2026-10-04.json       # 当日账本 + notified 标记
   └─ 2026-10-03.json       # 归档
```

路径规则：`process.env.DSH_HOME || join(homedir(), '.dsh')`，与 dsh 自身保持一致。

**写入策略**：每轮追加写当日文件。JSONL 优于单文件 JSON——并发写不会互相覆盖，且崩溃时最多丢最后一轮。

---

## Cordis 接入点（已核实）

| 用途 | 确切写法 |
|---|---|
| 订阅模型请求 | `ctx.on('llm/stream', (options, next) => ...)` |
| 订阅轨迹事件 | `ctx.on('session/event', (session, event) => ...)` |
| 注册斜杠命令 | `ctx.commands.register({ name, description, input, handler })` |
| 注册 HTTP 路由 | `ctx.webServer.register({ kind: 'exact', path, handler })` |
| UI 槽位 | `ctx.slots.inject('settings.section', () => ctx.slots.register({...}))` |
| 硬依赖 / 软依赖 | `ctx.inject(['commands'], cb)` / `ctx.get('sessions')` |
| 副作用清理 | `ctx.effect(() => { ...; return dispose }, 'tag')` |

**插件约定**：导出 `name`（小写），导出 `apply(ctx)`。配置层`name` 字段必须等于 npm 包名。

**三个必须写进 README 的坑：**

1. **配置是整条目替换，不深合并**。同id 段落必须合并，不能并列两段。
2. **`retainRatio` 必须小于 `thresholdRatio`**，否则配置加载失败（默认 0.16 / 0.8）。
3. **`tool-result-pruner` 只在压缩后生效**。阈值前工具输出无上限累积，这是长会话隐性成本的主因之一。

**已核实的服务名**：`webServer` / `commands` / `systemPrompt` / `tools` / `agents` / `sessionPersistence` / `logger`。

---

## usage 字段（已实测确认）

数据源：`~/.dsh/sessions/<workspace>/<session>/session.v{3,4}.jsonl.zstd`
样本：10 文件 / 2136 事件 / **237 条** 带 usage 的 `assistant/message`。

事件结构：顶层 `{ type, seq, time, data }`，`time` 为毫秒时间戳。

```json
{
  "type": "assistant/message", "seq": 2700, "time": 1788872821627,
  "data": { "usage": {
    "inputTokens": 814, "outputTokens": 154,
    "cacheReadTokens": 8320, "cacheWriteTokens": 0,
    "totalTokens": 9288, "reasoningTokens": 28
  } }
}
```

**核心语义（237/237 精确匹配）**

```
totalTokens = inputTokens + outputTokens + cacheReadTokens
```

- **`inputTokens` 是净新增输入，不含缓存命中部分**
- `totalTokens` **不是**当轮实际送进模型的上下文长度
- **计价必须三段分开算**：`cacheRead` 走缓存价、`input` 走未命中价、`output` 走输出价
- 合并算或只按 `inputTokens` 计价，在高缓存命中时**严重低估成本**（本机样本 cacheRead 是 inputTokens 的 13 倍）

**字段可变性**：`cacheWriteTokens` 仅 119/237 条存在，`reasoningTokens` 仅 118/237 条存在。**缺失必须按 0 处理，禁止抛错。**

**模型归属**：`assistant/message` 的 `data` 里**没有** model 字段。需用 `model/selection` 事件（携带 `provider`/`model`/`reasoningEffort`）按时间序最近匹配。

```json
{ "type": "model/selection", "time": 1788872638622,
  "data": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" } }
```

**未能确认**：`cacheWriteTokens` 在本机样本恒为 0，无法判断是否已计入 `totalTokens`。按"已计入"处理，`COST-MODEL.md` 标注此假设。

**多帧 zstd 坑**：dsh 的 `.zstd` 是**每帧一个 JSON 行**的多帧结构。`zstdDecompressSync` 只解第一帧（实测 192KB 文件仅得 229 字节），必须逐帧遍历 magic。

---

## 与官方 `.dshw-usage.json` 的关系

本机 `~/.dsh/.dshw-usage.json` **已存在按日聚合的用量账本**（`events[]` 含 ts/day/model/cost/tokens，`accounting.books` 含余额扣减）。

| 能力 | 官方账本 | 本插件 |
|---|---|---|
| 按日聚合、事件明细 | 有 | 有 |
| 余额扣减 | 有 | 不做 |
| **用户可设预算** | 无 | 有 |
| **阈值提醒 + 去重** | 无 | 有 |
| **归因** | 无 | 有 |
| 高峰/空闲差异化计价 | 无 | 有 |

**本插件是控制层，不是记账层。** 官方账本记"花了多少"，本插件管"超了没有、该怎么停"。

实现约束：**只读** `.dshw-usage.json`，绝不覆盖。因其 `events[]` 无 input/output/cache 拆分，无法归因与自验计价，故仍需自建账本。

---

## 待验证项

`llm/stream` 事件与 `session/event` 的触发时机关系。本方案 collector 基于 `session/event`（已验证存在），但**运行时订阅路径未验证**。若 `session/event` 只在会话结束后触发，需改用 `llm/stream` 实时采集。

计划：两者都接。`llm/stream` 用于实时采集，`session/event` 用于回填与校准，互为冗余。


---

## 风险与边界

| 风险 | 缓解 |
|---|---|
| 宿主预览期 API 漂移 | 能力探测 + 降级运行；锁版本测试；把宿主类型依赖从发布包剥离 |
| usage 字段不可得（部分 provider） | 降级为估算，标注 `estimated: true`，不伪装成精确值 |
| 计价表随官方调整漂移 | `pricing.mjs` 独立可更新，带 `pricingVersion`，文档标注生效日期 |
| 提醒变成噪音 | 每档每日去重（硬规则）；主通道是主动查询而非推送 |
| 跨时区日界错位 | 日界用本地时区，计价用北京时间，行为在 `DAY-BOUNDARY.md` 明确标注 |
| 装载第三方插件本身有风险 | 声明权限清单：无网络外发、不读凭证、只写自己的目录 |

---

## 隐私

- 不外发任何数据，**零网络请求**
- 不读取 `~/.dsh/.credentials.yaml`
- 只写 `$DSH_HOME/token-guard/` 目录
- 账本可能包含工具名与截断后的片段，`.gitignore` 已排除

---

## License

MIT
