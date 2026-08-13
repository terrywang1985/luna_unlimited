# Luna Unlimited · 通用 Agent 能力路线图

> 目标：把 Luna 做成一个 **AI / Agent 厂商无关（vendor-neutral）的本地能力层**。
>
> Luna 不属于 ChatGPT，也不属于 Claude Code、Codex、Gemini CLI 或 AgentRoom。
> 它只负责把本机 workspace、文件、命令、进程、测试等能力，以安全、可审计、可授权的方式暴露给任何兼容客户端。
>
> 理想结构：
>
> ```text
> ChatGPT ───────┐
> Claude Code ───┤
> Codex ─────────┤
> Gemini CLI ────┤── MCP / Adapter ── Luna Core ── Local Workspace / OS
> AgentRoom ─────┤
> Custom Agent ──┘
> ```
>
> 核心原则：**协议可换，模型可换，Host 可换，本地能力和安全策略不换。**
>
> v0.8.0 之后的近期版本任务、优先级和完成标准统一维护在 [TODO.md](TODO.md)；本文继续作为长期架构与安全约束。

---

# 1. 顶层设计原则

## 1.1 Luna Core 不感知模型厂商

Core 代码中不要出现类似：

```text
openai*
chatgpt*
claude*
anthropic*
gemini*
```

来决定工具行为。

Core 只理解：

- workspace
- path
- file operation
- command
- process
- permission
- approval
- audit
- capability
- session/caller metadata

模型是谁，不应该改变文件系统和命令层的实现。

---

## 1.2 MCP 是第一适配协议，不是产品本体

当前优先使用 MCP 是正确的，因为多个 AI Host 已经支持 MCP。

但工程结构必须允许未来增加：

```text
/adapters/mcp
/adapters/http
/adapters/stdio
/adapters/agentroom
```

而不是把所有业务逻辑写在 MCP `registerTool()` callback 里。

推荐分层：

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

MCP Adapter 只做：

1. 参数 schema；
2. MCP request → Core request；
3. Core result → MCP result。

**所有真正的权限判断必须在 Core。**

否则未来做 Claude Code adapter / AgentRoom adapter 时容易出现两套安全逻辑。

---

## 1.3 Tool 名称与语义保持模型中立

推荐：

```text
read_text_file
apply_patch
exec_command
stat_path
```

不要：

```text
chatgpt_read_file
claude_bash
codex_patch
```

返回结构也不要带某个厂商专有字段。

---

## 1.4 Compact Domain Tool 与 Action Registry

MCP 的公开 Tool 列表保持紧凑，不能随 Core 能力增长而无限平铺。v0.7.0 起采用两层命名：

```text
MCP public tool             Core action
workspace.read(text)   -->  workspace.read_text
workspace.manage(delete) -> workspace.delete
git.read(status)       -->  git.status
git.remote(clone)      -->  git.clone
```

公开 Tool 按领域和风险边界组织；拥有多个操作时，使用根对象中的 `request`，并以 `operation` discriminated union 产生对 Host 可见的 `oneOf` Schema。不要实现任意字符串形式的万能 `execute(action, args)`。

Core Action 必须保持细粒度，并独立声明：

- permission；
- risk level；
- approval protection；
- audit id；
- public Tool 与 operation 映射。

一个聚合 Tool 内的只读与写入操作不得因此共享 Core 权限。例如 `git.status` 不能因为与 `git.clone` 同属 Git 领域就获得网络权限。当前 SDK 无法正确把根级 union 输出到 `tools/list`，所以 union 放在顶层 `request` 属性中；测试必须验证 `request.oneOf` 实际可见。

---

## 1.5 Capability Discovery 是一等能力

不同 Host 支持能力不同，而且网页工具可能存在缓存。

必须提供：

```text
get_capabilities()
```

建议返回：

```json
{
  "server": {
    "name": "luna-unlimited",
    "version": "0.8.0"
  },
  "protocol": {
    "adapter": "mcp",
    "version": "..."
  },
  "workspace": {
    "rootName": "AgentRoom",
    "writable": true
  },
  "features": {
    "read": true,
    "search": true,
    "patch": true,
    "exec": true,
    "process": false,
    "checkpoint": true
  },
  "tools": {
    "read_text_file": { "enabled": true, "requiresApproval": false },
    "write_text_file": { "enabled": true, "requiresApproval": true },
    "exec_command": { "enabled": true, "requiresApproval": true }
  },
  "limits": {
    "maxFileBytes": 1048576,
    "maxCommandSeconds": 300
  },
  "policy": {
    "version": 1,
    "revision": 12,
    "approvalEnabled": true,
    "networkAllowed": false
  }
}
```

要求：

- 返回每个 Tool 当前是否启用；
- 返回每个 Tool 当前是否需要审批；
- 返回 policy schema version 与递增 revision；
- workspace 只返回安全别名 / root name，**不得返回真实绝对路径**；
- 不返回 secret、token、Tunnel credential 或其他本机敏感信息。

Agent 每次新连接都可以先探测能力，而不是依赖模型记忆。

---

# 2. 当前能力

当前 v0.8.0 对 Host 暴露 14 个 Compact Domain Tools，并由 27 个 Core Actions 承载细粒度安全语义。旧的 23 个平铺 Tool 已在项目尚无外部用户时一次性删除，不保留 legacy Adapter：

```text
luna.capabilities
system.execute
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

`system.execute` 只在本机所有者显式选择 `user`、`container-root` 或 `host-root` 执行档位时启用。该 Action 无条件要求本地逐次审批；全局观察模式不能绕过。root 档位必须验证 Linux effective UID，并区分容器 root 与宿主机 root。远端调用不能修改执行档位，restricted 也不能从 Dashboard 临时升级。

现有安全边界：

- 单 workspace root；
- 拒绝绝对路径；
- 防止 `..` 逃逸；
- 防止 symlink 逃逸；
- 隐藏 `.git` 内部数据；
- 拒绝 `.env`、私钥、credentials 等敏感文件；
- 文件大小限制；
- command timeout；
- command output limit；
- command environment secret filtering；
- Git/npm/Go 的 workspace-only project discovery 与执行控制环境隔离；
- 搜索不继承 workspace 父目录的 ignore 规则；
- `read_text_file` 的可见文本与结构化 `text` 字段都包含正文，元数据同时保留且 audit 不记录正文；
- tool permission switch；
- approval；
- audit log；
- local dashboard。
- 非 Git `local-snapshot` checkpoint backend，私有存储位于 workspace 外；
- restore 使用 workspace 独占锁，失败回滚；
- unified diff 支持 dry-run 与多文件事务提交，每个触及路径强制声明 SHA-256 或新文件 `null` 预期；
- 文件移动/删除强制 revision、敏感路径与 symlink 扫描，workspace 根不可破坏；
- PDF、XLS/XLSX、PNG/JPEG/GIF/WebP 可通过 Host 文件参数安全导入，任意二进制可检查并通过短时 MCP resource link 导出；
- Host 文件和生成物统一通过 `import_artifact.file` 的正式 `openai/fileParams` 路径进入；Host 在 MCP 调用前把 proxied mount 重写为完整 `{download_url,file_id,mime_type?,file_name?}`，Core 不接收裸引用或网页沙箱路径；
- HTTPS 下载使用 DNS 解析后地址固定，并同时支持 Node 的单地址和 `all:true` lookup callback 形态；导入结果/audit 只保留 `sourceScheme` 或 source 字段存在性/类型，不记录 URL、完整 file id 或 token；
- `clone_repository` 只接受公开 `github.com` 无凭据 HTTPS URL，关闭重定向、系统/全局 Git 配置、credential helper、代理、交互认证、LFS smudge 和子模块初始化；先在随机临时目录校验文件数、大小、敏感路径、符号链接和 HEAD，再原子提交到 workspace 新目录；

当前已经可以做到：

```text
discover → inspect/hash → search/read → atomic batch write/patch → install → build/test
```

本轮已补齐中等规模工程创建最关键的可靠性底座：安全 capability discovery、已有文件 SHA-256 冲突保护、进程内 per-file mutation queue、整批验证与失败回滚、禁止 npm lifecycle scripts 的受控依赖安装，以及命令侧不越过 workspace 的项目发现边界。

尚未完成的完整工作站 Agent 能力包括私有仓库 OAuth、Excel 单元格编辑、PDF 提取/渲染、policy persistence、长进程和结构化 diagnostics。它们仍按后续 Milestone 推进，不应把 v0.8.0 宣称为完整文档处理 Runtime。

---

# 3. P0：必须补齐的通用原语

## 3.1 get_capabilities

优先级：最高。

用途：任何 AI Host 在开始工作前都能知道 Luna 当前版本和权限。

接口：

```text
get_capabilities()
```

不要假设调用者是 ChatGPT。

可记录 caller metadata，但 caller 只能用于 audit，不得自动提升权限。

---

## 3.2 stat_path

```text
stat_path(path)
```

返回：

```json
{
  "path": "src/server.mjs",
  "type": "file",
  "size": 12345,
  "mtime": "...",
  "sha256": "...",
  "readable": true,
  "writable": true
}
```

用途：

- 判断文件是否存在；
- 避免读取大文件；
- 并发写冲突检测。

---

## 3.3 文件版本 / 冲突保护

read 建议返回：

```text
content + sha256 + mtime
```

所有写操作允许携带：

```text
expected_sha256
```

如果用户或另一个 Agent 已经修改：

```text
CONFLICT_FILE_CHANGED
```

拒绝覆盖。

这对未来多 AI / 多 Agent 同时操作尤其重要。

不要依赖“Agent 自觉重新读取”。

---

## 3.4 apply_patch

这是下一阶段最重要的写工具。

```text
apply_patch(
  patch,
  expected_files?,
  expected_hashes?,
  dry_run=false
)
```

支持 unified diff。

要求：

- 一次支持多文件；
- 所有路径必须在 workspace；
- sensitive paths 拒绝；
- context mismatch 时整体失败；
- 支持 dry-run；
- 返回 changed files / added lines / removed lines；
- approval UI 可展示 diff；
- audit 不保存秘密正文。

这里的“整体失败”必须按事务语义定义，而不是仅仅返回一个总错误：

1. 先 parse 全部 patch；
2. 校验全部路径、hash、context 和 policy；
3. 在内存/临时区生成全部目标内容，不立即覆盖原文件；
4. 全部校验通过后才进入 commit；
5. commit 过程中任一写入失败，必须恢复已经写入的文件；
6. 只有全部文件成功落盘才返回 success；
7. audit 应区分 validation failure、rollback 和 committed。

不能出现多文件 patch 部分写入后直接返回 error 的半提交状态。

不要实现成模型厂商特定 patch 格式。

**Unified Diff 是首选公共格式。**

如果未来某 Host 产生特殊 patch 格式，由 Adapter 转成 Core PatchRequest。

---

## 3.5 基础文件系统操作

新增：

```text
create_directory(path)
move_path(source, destination, overwrite=false)
delete_path(path, recursive=false)
```

可选：

```text
copy_path(source, destination, overwrite=false)
```

`delete_path` 默认高风险，需要 approval。

`move_path(overwrite=true)` 默认高风险。

---

## 3.6 exec_command 变成策略驱动，而不是代码硬编码

继续坚持：

```text
program
args[]
cwd
shell=false
```

不要默认开放：

```text
powershell "任意字符串"
cmd /c "任意字符串"
bash -c "任意字符串"
```

但是当前 allowlist 太窄，需要变成配置驱动。

建议 Core：

```text
CommandPolicy
  program
  allowedSubcommands
  argumentRules
  riskLevel
  networkAccess
  requiresApproval
```

例如：

```json
{
  "git": { "risk": "read", "enabled": true },
  "node": { "risk": "build", "enabled": true },
  "npm": { "risk": "build", "enabled": true },
  "go": { "risk": "build", "enabled": true },
  "cmake": { "risk": "build", "enabled": true },
  "python": { "risk": "system", "enabled": false }
}
```

### 可变项目脚本不是天然安全白名单

特别注意：允许 `npm test` / `npm run build` 并不等于只允许测试或构建。如果 Agent 同时可以修改 `package.json`，它可以先改写 script，再通过允许的 npm 命令执行任意程序。因此这属于 **transitive execution / mutable manifest** 风险。

同类风险还包括其他会从 workspace 读取可执行配置、插件、hook 或脚本的工具。

CommandPolicy 必须考虑：

- 项目脚本属于执行 workspace 中可变代码；
- 默认至少归类为 `build` 高风险并可要求 approval；
- 更严格模式下，可信 project command 应由 Luna 本机 policy / `.luna` 的受保护配置定义，而不是仅信任可被 Agent 修改的 manifest；
- 可选绑定 command definition / manifest hash，修改后要求重新审批；
- audit 应记录最终解析后的项目命令来源与 revision，而不是只记录 `npm test` 四个字；
- 不允许通过“先修改 manifest，再调用白名单脚本”绕过 program/argument policy。

建议风险层：

```text
read
write
build
network
system
```

具体模型是谁不参与风险判断。

---

# 4. P0：项目上下文标准化

## 4.1 优先读取 AGENTS.md

Agent 应该能得到项目自己的工作规则。

建议：

```text
get_project_context(cwd=".")
```

搜索：

```text
AGENTS.md
```

可兼容读取：

```text
CLAUDE.md
```

但 Core 返回统一结构，不把某种文件格式变成内部协议。

例如：

```json
{
  "instructions": "...",
  "sources": [
    { "path": "AGENTS.md", "kind": "agent-instructions" },
    { "path": "src/AGENTS.md", "kind": "agent-instructions" }
  ]
}
```

未来也可以由 Adapter 自行补充 Host 私有约定。

---

## 4.2 Luna 自己不要依赖 Prompt 才安全

`AGENTS.md` 可以说：

```text
不要修改 generated/
```

但真正关键安全规则不能只写 Prompt。

例如：

- 禁止读 secrets；
- workspace root；
- command allowlist；
- delete approval；

必须由 Core 强制执行。

---

# 5. P1：完整开发闭环

## 5.1 detect_project

```text
detect_project(cwd=".")
```

识别：

- Node.js
- Go
- Python
- Rust
- CMake/C++
- .NET
- Unity

返回：

```json
{
  "languages": ["javascript"],
  "packageManagers": ["npm"],
  "buildCandidates": [["npm", "run", "build"]],
  "testCandidates": [["npm", "test"]]
}
```

只负责探测，不擅自安装依赖。

---

## 5.2 项目命令抽象

支持项目配置：

```text
.luna/project.json
```

例如：

```json
{
  "commands": {
    "build": ["npm", "run", "build"],
    "test": ["npm", "test"],
    "lint": ["npm", "run", "lint"]
  }
}
```

然后提供：

```text
run_project_command(name)
```

这比无限扩展 arbitrary shell 更安全。

而且所有 AI Host 使用完全相同的命令定义。

---

## 5.3 Structured Diagnostics

命令执行仍返回 stdout/stderr，但 build/test 高层工具最好附加结构化 diagnostics：

```json
{
  "success": false,
  "exitCode": 1,
  "diagnostics": [
    {
      "file": "src/a.ts",
      "line": 42,
      "column": 3,
      "severity": "error",
      "message": "..."
    }
  ]
}
```

Adapter 再根据不同 Host 能力决定如何呈现。

---

## 5.4 Checkpoint / Undo

未来多 Agent 操作时非常重要。

提供统一抽象：

```text
create_checkpoint(label?)
list_checkpoints()
restore_checkpoint(id)
```

Core 不要求调用者懂 Git，也**不得假设 workspace 一定是 Git 仓库**。当前项目目录本身就可能不是 Git 仓库，因此 checkpoint API 必须与 Git 解耦。

底层实现应支持可替换 backend：

- Git snapshot（仅当仓库可用时）；
- local patch bundle；
- local snapshot / temporary copy / copy-on-write 类方案。

Checkpoint Core API 对上层保持一致，由 backend 自行选择可用实现。`restore_checkpoint` 必须 approval。

---

## 5.5 Git 写操作是可选高级能力

可以未来支持：

```text
git_commit(message, paths?)
git_create_branch(name)
```

默认不要开放：

```text
push
force push
reset --hard
clean -fd
remote mutation
credential commands
```

把“代码编辑”与“发布到远端仓库”分成两个权限域。

---

# 6. P1：多 Client / 多 Agent 并发

这是 Luna 真正通用后迟早会遇到的。

## 6.1 caller identity

Core 内部定义通用调用者：

```json
{
  "clientId": "...",
  "clientName": "claude-code",
  "sessionId": "...",
  "protocol": "mcp"
}
```

注意：

- 这些字段用于审计和冲突定位；
- 不信任 client 自报身份；
- 身份不能自动获得额外权限。

---

## 6.2 不要把 MCP Session 当业务 Session

协议 session 和 Luna 工作 session 分离。

Core 可使用自己的：

```text
workSessionId
```

未来即使 MCP 协议版本改变、HTTP adapter 接入，工作记录仍能继续。

---

## 6.3 并发写必须用 hash / revision 防冲突

场景：

```text
Claude Code read A
ChatGPT read A
Claude Code patch A
ChatGPT patch old A
```

第二个 patch 必须得到 conflict，而不是覆盖第一个修改。

---

## 6.4 Workspace Lock 只作为可选机制

不要默认一个 Agent 独占整个项目。

可未来提供：

```text
acquire_lock(path, ttl)
release_lock(lockId)
```

但首选仍然是 optimistic concurrency（hash/revision）。

---

# 7. P2：进程与本地服务

未来完整 Coding Agent 常需要启动程序。

建议：

```text
start_process
get_process
read_process_output
stop_process
list_processes
```

原则：

- Luna 只能管理自己启动的 process；
- 不能随意 kill 系统进程；
- TTL；
- output limit；
- Dashboard 可见；
- background process 属高风险能力。

---

## 7.1 localhost HTTP 测试

增加：

```text
http_request(...)
```

默认只允许：

```text
127.0.0.1
localhost
```

公网网络权限单独控制。

这使任意 AI Host 都可以：

```text
启动服务 → localhost 请求 → 看结果 → 修改 → 重试
```

---

# 8. Protocol Adapter 设计

## 8.1 Core Request / Result

建议 Core 方法统一使用普通对象：

```text
core.files.read(request, context)
core.patch.apply(request, context)
core.commands.exec(request, context)
```

`context`：

```json
{
  "caller": {},
  "workSessionId": "...",
  "approvalContext": {}
}
```

返回：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "durationMs": 12,
    "auditId": "..."
  }
}
```

错误返回统一 error code：

```text
PATH_OUTSIDE_WORKSPACE
SENSITIVE_PATH
FILE_TOO_LARGE
FILE_CHANGED
COMMAND_NOT_ALLOWED
APPROVAL_REQUIRED
APPROVAL_DENIED
TIMEOUT
OUTPUT_TRUNCATED
```

不要让 Adapter 根据错误字符串猜语义。

---

## 8.2 MCP Adapter

职责：

```text
MCP schema
→ Core DTO
→ call Core
→ Core error/result
→ MCP content / structuredContent
```

MCP Tool schema 与 Core schema 尽量接近，但不要反向让 Core 依赖 MCP SDK 类型。

---

## 8.3 未来 Claude Code / 其他 Host

优先策略不是给每家 AI 写专门服务器。

只要 Host 支持 MCP：

```text
Host → MCP Adapter → Luna Core
```

例如 Claude Code 本身支持连接 MCP Server，因此理想情况下无需 Claude 专用实现。

如果某个未来 Host 不支持 MCP，再增加对应 Adapter：

```text
Host → Custom Adapter → Luna Core
```

Core 不变。

---

## 8.4 AgentRoom Adapter

未来 AgentRoom 很可能同时承担：

- 多 Agent 协作；
- 人类用户；
- 节点发现；
- 跨机器；
- 权限管理。

不要把这些逻辑塞进 Luna Core。

更合理：

```text
AgentRoom Runtime
      ↓
AgentRoom Adapter / MCP Client
      ↓
Luna Core
      ↓
本机能力
```

Luna 是 Node Capability Layer，不是多 Agent 编排器。

---

# 9. MCP 版本兼容策略

MCP 本身会演进，所以不要把当前 SDK 生命周期行为当成永恒协议。

建议：

1. Adapter 封装 SDK；
2. Core 不 import MCP SDK；
3. `package.json` 锁 SDK 版本；
4. 增加协议兼容测试；
5. 升 SDK 时只重点修改 adapter；
6. `get_capabilities` 返回 Luna feature，而不是简单复制 MCP capability。

这样即使 MCP transport/session 机制变化，Core 基本不动。

---

# 10. Policy 持久化与版本

当前实现中的 Tool permission 和 approval mode 只存在于内存，服务重启后会恢复默认值。正式架构必须加入本地 policy persistence。

要求：

- policy 存在 Luna 自己的本地私有配置目录，不放在远端 Agent 可直接读写的 workspace；
- 原子写入，避免崩溃产生半份配置；
- 配置包含明确的 schema `version`；
- 每次有效修改递增 `revision`；
- 无效/损坏配置必须 fail closed 或回退到安全默认值；
- permission、approval、command policy 等最终都从同一 Core PolicyStore 读取；
- Dashboard 是 policy 的本机管理入口之一，远端 Agent 只能查询安全摘要，不能自行扩大权限；
- `get_capabilities` 返回 version/revision 和安全摘要，不返回真实绝对 workspace 路径或秘密。

---

# 11. 安全边界：任何 AI 都一样

## 禁止远端 Agent 自己扩大权限

Agent 可以查询：

```text
get_capabilities
get_policy
```

但不能自行：

```text
set_workspace_root
turn_off_approval
allow_powershell
allow_secret_files
```

这些操作只能来自本机 Dashboard / Desktop UI。

---

## 禁止读取敏感凭据

包括：

```text
.env
SSH keys
Git credentials
browser cookies
Tunnel credentials
API tokens
npm credentials
cloud credentials
```

无论调用者是 ChatGPT、Claude Code 还是 AgentRoom，都执行相同规则。

---

## 默认不要裸 shell

未来可以有用户显式开启的：

```text
Trusted Local Agent Mode
```

但它是额外模式，不是默认模式。

默认仍然：

```text
program + args[]
shell=false
policy enforcement
approval
```

---

# 12. 推荐 Public Tool / Core Action 结构

公开 MCP Tool 保持在大约 10～20 个领域入口，而 Core Action 可以随能力增加到数十或上百个：

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

未来增加能力时优先扩展现有领域的 `request.operation`，但必须同时满足：

1. operation 输入仍是严格 Schema；
2. 新操作与该公开 Tool 的风险注解相容；
3. Core Action 拥有独立 permission、approval 和 audit；
4. 如果风险边界不同，新增一个领域 Tool，而不是塞进万能路由器。

例如进程能力应拆成：

```text
process.read       # list / inspect / output
process.control    # start / stop
```

而不是把只读查询、启动、停止和系统进程管理全部放进 `process`。核心目标是同时控制工具目录大小、Schema 复杂度和安全语义，不以“工具数量最少”为唯一指标。

---

# 13. 推荐实现顺序

## Stage 0：历史行为锁定测试（Milestone A 前置，已完成）

这是 Milestone A 重构时采用的历史基线。v0.7.0 经项目所有者授权主动替换了这份外部 Contract；旧 7/23 Tool 不再作为兼容目标，当前契约以第 12 节的 Compact Domain Tool 为准。v0.8.0 又新增了独立的 `system.execute` 领域工具。

至少锁定：

1. Tool 名称与参数字段；
2. 成功返回结构和关键字段；
3. 典型错误与 `isError` 行为；
4. workspace、敏感路径、symlink 等安全行为；
5. permission disabled 行为；
6. approval pause / approve / deny；
7. audit event 的关键字段与状态；
8. command allowlist 与结构化执行结果。

测试目标不是冻结内部实现，而是允许内部随意重构、同时及时发现外部行为被意外改变。

完成标志：

> 当前 7 个 Tool 的 contract、权限、审批、审计和安全边界都有自动化回归测试。

---

## Milestone A：协议和 Core 解耦

1. 从 `server.mjs` 抽出 `core/`；
2. MCP callback 不再直接操作 fs/process；
3. 定义统一 Core error code；
4. 定义 CallerContext / WorkSessionContext；
5. 当时保持 7 个 Tool 行为不变；
6. 当时的 Stage 0 行为锁定测试和现有测试全部通过。

完成标志：

> 不修改 Core，仅增加 Adapter 就理论上能接入另一个 Agent Host。v0.8.0 的 Adapter contract 由 14 个 Compact Domain Tool 测试锁定。

---

## Milestone B：可靠编辑闭环

1. `get_capabilities`
2. `stat_path`
3. read hash/revision
4. `apply_patch`
5. write conflict protection
6. create/move/delete
7. smoke tests

完成标志：

> 任意 MCP Agent 能完成中等规模 bugfix，不容易覆盖其他客户端刚做的修改。

---

## Milestone C：工程执行闭环

1. CommandPolicy 配置化
2. 项目探测
3. project commands
4. structured diagnostics
5. approval risk levels
6. Dashboard 展示真实 command/diff 风险

完成标志：

> Agent 能完成 read → patch → build/test → 修错 → diff。

---

## Milestone D：恢复与长任务

1. checkpoint
2. process manager
3. localhost HTTP
4. workspace-level session/audit

完成标志：

> Agent 可以启动本地项目、测试服务并安全回滚。

---

# 14. 桌面 Agent 实现时的强制要求

每新增一个能力都必须同时完成：

1. Core implementation；
2. path / policy validation；
3. audit；
4. approval classification；
5. MCP adapter；
6. Dashboard 可见性（如果涉及权限）；
7. positive test；
8. negative/security test；
9. README / capability documentation。

不要只做到“接口能跑”。

---

# 15. 最终产品定位一句话

**Luna Unlimited 是 AI-neutral 的 Local Agent Capability Runtime。**

它不是 ChatGPT 插件。

它应该做到：

> 任意获得用户授权的 AI Agent，都能通过标准协议安全使用本机开发能力；换模型、换 Host、换协议适配层，都不需要重写本地能力和安全体系。
