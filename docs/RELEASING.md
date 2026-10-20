
> 这份文档面向**维护者**。使用者只需看主 [README](../README.md) 的「安装」与「命令」两节。

# 发布流程

代码层面已完成，剩下的是**只能靠真机确认**的部分。

### 1. 建仓与推送

本仓库已推送。若需 fork 或重建，流程如下。

在 GitHub 上新建**空仓库**（不要勾选 README / .gitignore / License），然后一条命令完成推送：

```bash
node tools/setup-repo.mjs <你的GitHub用户名>            # HTTPS 推送（会弹浏览器登录）
node tools/setup-repo.mjs <你的GitHub用户名> --ssh      # SSH 推送（需先配置密钥）
node tools/setup-repo.mjs <你的GitHub用户名> --dry-run # 只预览，不做任何改动
```

脚本会自动填 `package.json` 元数据、替换 README 徽章地址、设置 remote、提交并推送。

#### 若要用 SSH

```bash
# 1. 生成密钥（回车接受默认路径，会问 passphrase，可留空）
ssh-keygen -t ed25519 -C "你的邮箱"

# 2. 复制公钥
cat ~/.ssh/id_ed25519.pub
```

把输出粘到 **GitHub → Settings → SSH and GPG keys → New SSH key**，然后验证：

```bash
ssh -T git@github.com
# 成功时会显示：Hi <用户名>! You've successfully authenticated...
```

看到这行再推送，就不会卡在 `Permission denied (publickey)`。

- 打 **`dsh-plugin`** topic —— 官方靠这个标签做插件发现，漏了等于没发布
- 仓库描述建议：`给 DeepSeek Harness 用的每日 token 预算管控：设上限、超阈值提醒、时段感知、超预算关闭任务`
- 仓库设置里开启 Issues / Discussions

### 2. 装上 dsh 实测五件事

按优先级排列，前三项不通过则核心功能不可用：

| # | 验证项 | 不通过的后果 |
|---|---|---|
| 1 | `agents` 服务的 `list()` / `get()` / `agent.cancel` / `whenIdle` 形状 | `/budget plan` 与 `stop` 不可用 |
| 2 |客户端 slot 名 `conversation.input.dock`（备选 `settings.section`） | 面板挂不出来，只剩斜杠命令 |
| 3 | HTTP 路由前缀 `/api/token-guard` 是否与宿主冲突 | 客户端拿不到数据 |
| 4 | `session/event` 的实际触发时机 | 退回 60s 轮询，功能不失效但延迟高 |
| 5 | `webServer.register` 的 disposer 返回约定 | 插件卸载后路由残留 |

`cordis_inspect_list` 可列出实际服务与槽位。

### 3. 补高峰时段的计价对账

本机 720 条样本**全部落在空闲时段**（0 条高峰，都在深夜与周末产生）。因此高峰时段的 `×1` 系数**仅有官方文档依据，未经实测**。

找一个工作日白天（9:00–12:00 或 14:00–18:00）用一次 dsh，然后跑 `npm run dump` 与官方 `.dshw-usage.json` 对账，补上这条验证。

### 4. 补真机截图

`docs/preview.png` 与 `docs/ui-preview.png` 当前都是**输出/形态预览**，由真实数据渲染但非真机截图。装上 dsh 后应替换。
