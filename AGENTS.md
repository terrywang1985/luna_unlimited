# Luna Unlimited · Agent Implementation Instructions

本项目目标不是做 ChatGPT 专用插件，而是做一个 **AI-neutral / vendor-neutral 的 Local Agent Capability Runtime**。

Luna Core 只负责安全地暴露本机 workspace、文件、命令、进程、测试、审批和审计能力。ChatGPT、Claude Code、Codex、Gemini CLI、AgentRoom 或其他客户端都只是 Host / Adapter，不得把任何厂商语义写进 Core。

## 开始修改前必须阅读

```text
AGENT_CAPABILITIES_ROADMAP.md
README.md
package.json
src/server.mjs
scripts/test-contract.mjs
scripts/test-mcp.mjs
scripts/test-admin.mjs
scripts/test-workspace.mjs
```

如果某文件暂不存在，先按路线图当前 Milestone 判断是否应该创建，不要因此跳过相关设计要求。

## Agent 邮箱

如果存在 `agent_comms/`，开始工作前先读取：

```text
agent_comms/PROTOCOL.md
agent_comms/web_to_desktop.md
```

如果 `web_to_desktop.md` 中有 `status: needs_reply` 的新消息，完成或评估后将回复写入：

```text
agent_comms/desktop_to_web.md
```

回复必须携带新的 `message_id` 并用 `reply_to` 指向收到的消息。通信文件只是协作层，不改变 Luna Core 的权限与安全策略。

## 当前开发顺序

严格按以下顺序推进：

### Stage 0 · Contract Freeze

在重构前先锁定现有 7 个 MCP Tool 的外部行为：

```text
list_directory
read_text_file
read_text_file_range
search_files
write_text_file
replace_text
exec_command
```

行为锁定至少覆盖：

1. tool 名称与参数字段；
2. 成功返回结构和关键文本/JSON 字段；
3. 典型错误与 `isError` 行为；
4. workspace / sensitive path 安全边界；
5. permission disabled 行为；
6. approval pause / approve / deny 行为；
7. audit event 的关键字段与状态；
8. command allowlist 和结构化输出。

**Stage 0 测试通过以前，不开始 Core/Adapter 大规模拆分。**

### Stage 1 · Milestone A：Core / Adapter 解耦

1. 把 workspace、文件、搜索、命令、权限、审批、审计逻辑从 `server.mjs` 抽到 `src/core/`；
2. MCP 只作为 Adapter；
3. Core 不 import `@modelcontextprotocol/sdk`；
4. MCP callback 不直接访问 fs/process；
5. 保持现有 7 个 Tool 外部行为兼容；
6. 定义统一 Core error code；
7. 定义 `CallerContext` / `WorkSessionContext`；
8. 所有 Stage 0 行为锁定测试持续通过。

### Stage 2 · Milestone B：可靠编辑原语

按路线图实现：

```text
get_capabilities
stat_path
read hash/revision
apply_patch
write conflict protection
create/move/delete
```

当前 v0.4.0 已按用户明确优先级提前完成非 Git checkpoint/restore。不要重复实现 checkpoint；下一项继续推进 atomic `apply_patch`，然后是 create/move/protected delete。

## 架构硬约束

推荐目录：

```text
src/
  core/
    workspace.*
    files.*
    search.*
    patch.*
    commands.*
    process.*
    policy.*
    approval.*
    audit.*
    capabilities.*

  adapters/
    mcp.*
    http-admin.*

  server.*
```

Core Request / Result 必须使用普通 DTO，不允许依赖某个模型厂商或 MCP SDK 类型。

## Caller 身份规则

`CallerContext` 可以包含：

```text
clientId
clientName
sessionId
protocol
workSessionId
```

但 caller 身份只用于：

- audit；
- 日志定位；
- 并发冲突定位；
- session 关联；
- UI 展示。

**不得因为调用者自称 ChatGPT、Claude Code、Codex、管理员或其他名称而自动提升权限。**

所有权限必须来自 Luna 本机 policy，而不是远端 caller 自报身份。

## 安全硬约束

以下规则不能只存在于 Prompt / AGENTS.md，必须由 Core 强制：

- workspace root；
- 拒绝绝对路径与 `..` 逃逸；
- symlink 防逃逸；
- sensitive path 拒绝；
- command allowlist / policy；
- secret environment filtering；
- output / timeout limits；
- write / execute / delete 等风险审批；
- audit。

任何新 Adapter 都必须复用同一 Core policy，不能复制一套自己的安全判断。

## 可变项目脚本的执行风险

不要把 `npm test`、`npm run build` 之类命令误认为天然安全。

如果 Agent 能修改 `package.json`，那么它可以先改写 script，再调用被 allowlist 允许的 npm 命令，从而绕过原本的 program/args 限制。其他从 workspace 读取 hook、plugin、task 或脚本的构建工具也存在同类问题。

因此后续 CommandPolicy 必须：

- 把项目脚本视为执行 workspace 中可变代码；
- 至少按 build/high-risk 分类并支持 approval；
- 可选把可信 project command 固定在 Luna 本机 policy / 受保护配置；
- 可选绑定 manifest/command revision 或 hash，发生变化后重新审批；
- audit 尽可能记录最终命令来源与 revision；
- 不允许“修改 manifest → 调白名单脚本”成为绕过策略的路径。

## Policy 持久化

当前 tool permission 和 approval mode 是内存状态，重启会恢复默认值。

后续实现 policy persistence 时要求：

- 存在 Luna 本地私有配置中；
- 不放入被远端 workspace 工具可读写的位置；
- 原子写入；
- schema/version 明确；
- 无效配置 fail closed 或安全回退；
- policy 每次变更递增 `policyRevision`；
- `get_capabilities` 只返回安全摘要，不泄露敏感本机路径或秘密。

## get_capabilities 要求

至少返回：

- Luna server/version；
- adapter/protocol；
- feature/limit 摘要；
- 每个工具当前是否 enabled；
- 每个工具当前是否 requiresApproval；
- policy version / revision；
- workspace 的安全别名或 root name。

**不得返回真实绝对 workspace 路径。**

## apply_patch 原子性

多文件 patch 的“整体失败”必须按事务语义实现：

1. parse 全部 patch；
2. 校验全部路径 / hash / context / policy；
3. 生成全部目标新内容但不落盘；
4. 所有校验通过后再进入 commit；
5. 写入过程中任一步失败，必须恢复已写入文件；
6. 只有全部成功才返回 success；
7. audit 必须能区分 validation failure / rollback / committed。

不能出现“前两个文件写成功，第三个失败，最后只返回 error”的半提交状态。

## Checkpoint 规则

不要假设 workspace 一定是 Git 仓库。

Checkpoint Core 必须抽象后端，至少允许：

- Git backend（仓库可用时）；
- local patch bundle；
- local snapshot / copy-on-write 类后端。

Git 只是可选实现，不是 checkpoint API 的前提。

当前 `local-snapshot` backend 的既有 contract 还要求：私有存储位于 workspace 外；敏感路径、`.git`、`node_modules` 和 Luna runtime logs 不进入快照；restore 取得 workspace 独占 mutation gate；失败必须回滚并在 audit 标记 `rolledBack`。

## Vendor-neutral 文案

代码、README、package metadata 和 UI 的产品定位应统一为 vendor-neutral。

避免把产品描述成：

```text
ChatGPT local MCP
OpenAI-only local agent
```

可以描述 MCP / Secure Tunnel 是当前一种 Adapter / transport，但不能把它写成产品本体。

## 修改纪律

每新增一个能力，至少同时完成：

1. Core implementation；
2. policy/path validation；
3. audit；
4. approval/risk classification；
5. Adapter exposure；
6. positive test；
7. negative/security test；
8. capability / README 文档更新；
9. 必要时 Dashboard 可见性。

改文件前先读文件。不要绕开现有工具安全限制。不要为了让测试通过而削弱安全边界。

## 当前完成标准

Stage 0 完成：现有行为被自动化测试锁定。

Milestone A 完成：

> 不修改 Core，仅新增 Adapter，理论上即可接入另一个 Agent Host；同时现有 7 个 Tool 的行为锁定测试全部通过。

Milestone B 完成：

> 任意兼容客户端都能可靠执行 inspect → read → patch → build/test，并通过 hash/revision 避免覆盖其他 Agent 的最新修改。
