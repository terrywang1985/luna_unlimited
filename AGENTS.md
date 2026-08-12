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

## 当前外部 Contract

Stage 0、Milestone A/B 和 v0.6.5 前的可靠编辑闭环已经完成。v0.7.0 经项目所有者明确授权进行了破坏性 Tool Surface 重构：旧的 23 个平铺 MCP Tool 已全部删除，不建立 legacy Adapter，也不得重新暴露。

当前 MCP 必须只暴露以下 13 个领域工具：

```text
luna.capabilities
workspace.read
workspace.write
workspace.manage
code.patch
artifact.read
artifact.import
checkpoint.read
checkpoint.write
git.read
git.remote
project.execute
project.dependencies
```

拥有多个操作的领域工具使用顶层 `request` 对象，内部以严格的 `operation` discriminated union 表达子操作。Core 使用 `src/core/actions.mjs` 中的细粒度 Action Registry；permission、approval 和 audit 必须针对 Action，不得因为 MCP Tool 聚合而合并风险。

`scripts/test-contract.mjs` 至少锁定：

1. 13 个公开 Tool 的精确名称，且旧平铺 Tool 不再出现；
2. `request.oneOf` 中的 operation 名称和参数结构；
3. 成功返回结构和关键文本/JSON 字段；
4. workspace / sensitive path 安全边界；
5. Action permission disabled 行为；
6. Action approval pause / approve / deny 行为；
7. audit event 使用真实 Action id；
8. Git 参数不允许从 `project.execute` 绕过 typed Git operation。

当前 v0.7.0 已完成 Action Registry / Compact Domain Tool Surface。下一阶段按 TODO 推进 policy persistence、project task 或 process manager，不重复实现既有 checkpoint、patch、Artifact Bridge 和公开 GitHub Clone。

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
- `luna.capabilities` 只返回安全摘要，不泄露敏感本机路径或秘密。

## luna.capabilities 要求

至少返回：

- Luna server/version；
- adapter/protocol；
- feature/limit 摘要；
- 每个公开 Tool 的 operation 目录；
- 每个 Core Action 当前是否 enabled / requiresApproval / approvalProtected；
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
