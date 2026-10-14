# 兼容性

本插件针对 **DeepSeek Harness（`dsh`）开发者预览版**。官方在 README 中明示会有破坏性变更，因此下表记录**实测过的版本**。

## 实测矩阵

| dsh 版本 | 平台 | 记账 | `/budget` | 停止任务 | HTTP 接口 | 客户端面板 |
|---|---|---|---|---|---|---|
| 0.1.x（含 `session.v4.jsonl.zstd`） | Windows 11 | 通过 | 通过 | 仅模拟验证 | 仅模拟验证 | 仅形态预览 |

**验证方式**
- 记账与计价——读取本机真实会话日志（13 文件 / 4.89 MB / 720 条 usage），与 dsh 自带 `.dshw-usage.json` 对账
- 计价公式——空闲时段两条事件与官方 cost **分位完全一致（比值 1.0000）**
- `/budget` 命令族——模拟 `commands` 服务，113 个自动化测试覆盖
- 停止任务——用模拟 `agents` 服务验证调用约定（**未在真机 agent 上执行过**）
- 客户端面板——只有 HTML 形态预览，**从未在浏览器里真正跑过**

**未在真机 dsh 上验证**（安装后请优先确认）
1. `agents` 服务的实际 API 形状（`list()` / `get()` / `agent.cancel` / `whenIdle`）
2. HTTP 路由前缀 `/api/token-guard` 是否与宿主冲突
3. 客户端 slot 名 `conversation.input.dock` 是否可用（备选 `settings.section`）
4. `session/event` 的实际触发时机
5. 高峰时段计价（本机 720 条样本**全部落在空闲时段**）

`cordis_inspect_list` 可列出实际服务与槽位。

## 停止功能的契约依赖

「关闭所有任务」建立在以下 dsh 契约之上（源码级核实，非推测）：

| 契约 | 用途 |
|---|---|
| `ctx.agents.list()` | 枚举 live agent |
| `Agent.cancel(cause, options)` | **唯一公开 stop 原语** |
| `Agent.whenIdle()` | 观察停止完成 |
| `AgentHandle.dispose()` | **不可用** —— 只对创建者开放 |

**为什么不用 `dispose()`**：它是「consumer capability」，只有持有 `AgentHandle` 的创建者才能调用。插件通过 `ctx.agents` 拿到的是裸 Agent（注册表观察者），**无权dispose**。

**为什么需要 `keepInbox` 选项**：默认 `cancel()` 会清空队列；若只想中止当前回合而保留排队工作（如Web stop 的行为），需显式传 `{ keepInbox: true }`。

### 三个已知局限

1. **无 plugin专属 cause**。`AgentCancelCause` 是封闭联合（只有 `user` / `parent`），预算插件触发的取消只能用 `'user'` —— 宿主无法区分来源。
2. **子 agent 一律跳过**。宿主对 session-backed 子 agent 返回 `agent-busy`；插件拿不到该守卫，因此对无法确认归属的采取保守跳过。
3. **取消是协作式的**。返回不代表工作已停。插件 `await whenIdle()` 并设3 秒上限，超时如实报告「可能仍在收尾」。

## 版本风险与降级

| 风险 | 表现 | 本插件的应对 |
|---|---|---|
| 事件名变更 | 收不到 `assistant/message` | 降级为 60s 轮询扫日志，功能不失效，只是延迟 |
| 日志格式变更 | 解析不出 usage | `collectAll` 返回空数组，`/budget` 显示 0，不崩溃 |
| `model/selection` 缺失 | 模型归为 `unknown` | 正常记账，`why` 明确标注「未归因」，不给误导建议 |
| `agents` API 形状变化 | 停止功能失效 | `plan` / `stop` 整体降级为「不可用」，`/budget` 其余功能不受影响 |
| agent id 字段名变化 | 无法枚举 | `classify` 返回「无法确定 agent 标识」并跳过，不强停 |
| `cancel` 不存在 | 无法停止 | 标记为不可停止并说明原因 |
| slot 名变更 | 客户端面板不出现 | 宿主功能不受影响，`/budget` 始终可用；控制台有warn |
| 计价表调整 | 成本偏差 | `pricingVersion` 标记版本，文档标注生效日期 |
| `cacheWriteTokens` 语义变化 | total 校验失败 | 公式集中在 `normalizeMessage`，一处可改 |

## 性能

数据规模从 2.18 MB（10 文件）增长到 4.89 MB（13 文件）后重测：

| 场景 | 耗时 |
|---|---|
| 冷解析（无缓存） | 330 ms |
| 热采集（命中缓存） | 4 ms |
| 记账重建 | 16 ms |

解析结果按「文件指纹（size + mtime）」缓存，因此热路径开销**与历史数据量无关**，只与新增数据量有关。

## 依赖的宿主 API

用到的服务（缺失时降级，不阻塞加载）：

| API | 用途 | 缺失后果 |
|---|---|---|
| `commands` | `/budget` 命令 | 无法交互查询，仍可看面板 |
| `webServer` | HTTP 接口 | 客户端面板拿不到数据 |
| `sessions` | 低延迟触发 | 退回 60s 轮询 |
| `agents` | 停止任务 | plan / stop 不可用，其余功能正常 |
| `ctx.effect` | 生命周期管理 | **必需**，插件无法工作 |
| `ctx.on('session/event')` | 实时事件 | 退回轮询 |

**刻意不用的 API**

- `agent.inject()` —— 会把内容塞进模型上下文，既消耗 token 又让模型看到提醒
- `systemPrompt.section()` —— 提醒不是提示词，不需要进模型视野

## Node 版本

需要 **Node.js 22.15+**（用到 `node:zlib` 的 zstd 支持）。Node 20 及更早版本没有 `zlib.zstdDecompress*`。

## 数据格式

会话日志为**多帧 zstd**（每帧一个 JSON 行）。`zlib.zstdDecompressSync` 只解第一帧——实测 192KB 文件仅得 229 字节。必须逐帧遍历 magic `28 b5 2f fd`。

已支持：`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`、`session.jsonl.zstd`。

## 隐私

- 零网络请求
- 不读 `~/.dsh/.credentials.yaml`
- 只读会话日志，**不改写任何请求**
- 只写 `$DSH_HOME/token-guard/`
- 账本含 token 数、成本、模型名与工具名（不含消息正文），已由 `.gitignore` 排除
