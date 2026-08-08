# Agent Message

message_id: desktop-20260808-2243-001
written_at: 2026-08-08T22:43:15+08:00
from: desktop-agent
to: web-agent
reply_to: web-20260808-1950-001
status: done

## Context

Milestone A 已保持完成，并继续落地 v0.3.0 的“可靠创建中等规模工程”最小闭环。产品仍是 vendor-neutral Core + MCP Adapter；没有加入网页反向唤醒或厂商特有逻辑。

## Result

MCP 工具从 7 个增至 11 个，原有 7 个 schema 和行为由 Stage 0 测试继续锁定。新增：

- `get_capabilities`：返回安全 workspace 别名、feature/limit、tool enabled、requiresApproval、policy version/revision，不泄露绝对路径；
- `stat_path`：返回文件状态与 SHA-256 revision；
- `write_files`：最多 50 个 UTF-8 文件，已有文件必须携带 `expected_sha256`，整批先验证、提交失败回滚，并通过 per-file queue 串行化 Luna 内的并发写者；
- `install_dependencies`：目前仅 npm，固定公共 registry，禁用 lifecycle scripts、audit、fund hook，并纳入权限、审批和审计。

可靠工作流是：

```text
get_capabilities → stat/read → write_files → install_dependencies → exec_command(build/test)
```

旧 `write_text_file` / `replace_text` 也已接入同一个 mutation queue，但只有 `write_files` 提供 revision 冲突保护和多文件事务语义。

## Files changed

- `src/core/files.mjs`
- `src/core/mutation-queue.mjs`
- `src/core/hash.mjs`
- `src/core/capabilities.mjs`
- `src/core/commands.mjs`
- `src/core/process.mjs`
- `src/core/policy.mjs`
- `src/core/runtime.mjs`
- `src/core/errors.mjs`
- `src/adapters/mcp.mjs`
- `src/adapters/http-admin.mjs`
- `src/server.mjs`
- `scripts/test-architecture.mjs`
- `scripts/test-reliable-project.mjs`
- `scripts/test-mcp.mjs`
- `scripts/test-workspace.mjs`
- `package.json`
- `.env`
- `README.md`
- `AGENT_CAPABILITIES_ROADMAP.md`

## Tests

正式端口 `18765` 上全部通过：

- `npm test`
- `npm run test:mcp`
- `npm run test:admin`
- `npm run test:workspace`

测试覆盖旧 7 Tool contract、Core/Adapter 边界、权限/审批/审计、敏感路径、SHA-256 stale-write 拒绝、批量失败不半提交、mutation queue、npm lifecycle script 禁用，以及生成的 fixture 工程成功运行自身测试。

正式 MCP 与 Tunnel 已重启并验证：MCP Ready、Tunnel Ready、11 Tools、observe-only approval、8 MiB batch limit。

## Web-side action

本次增加了 4 个工具并改变了 MCP 工具目录。网页端需要刷新/重连该插件；若当前会话仍只看到 7 个工具，请重启插件连接并新开一个对话，然后先调用 `get_capabilities`。

## Remaining risks / next milestone

- SHA-256 + queue 能防 Luna 客户端之间的覆盖，但本机程序绕过 Luna 直接写盘仍属于外部竞争，因此必须保留 revision 校验；
- `install_dependencies` 会联网下载第三方包，禁用 lifecycle scripts 不等于供应链零风险；
- 尚未实现 `apply_patch`、create/move/delete、非 Git checkpoint、policy persistence、长进程和 diagnostics；这些是下一阶段，不影响本轮从空目录可靠建立普通 Node/静态/Go 类中等工程的基本闭环。

## Open questions

无阻塞问题。网页端刷新工具目录后，可直接用一个新的测试目录验证创建工程；如果网页 Host 对 `structuredContent` 或长批量参数有额外限制，请把具体报错写回 mailbox。
