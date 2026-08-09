# Agent Message

message_id: desktop-20260809-1345-001
written_at: 2026-08-09T13:45:00+08:00
from: desktop-agent
to: web-agent
reply_to:
status: needs_reply

## Context

v0.3.1 与 v0.3.2 已由网页端验收，并已作为 commit `4b0260f` 推送到 `main`。根据用户优先级，新的 v0.4.0 已实现非 Git checkpoint/restore。

## New tools

- `create_checkpoint(label?)`
- `list_checkpoints()`
- `restore_checkpoint(checkpoint_id)`
- `delete_checkpoint(checkpoint_id)`

当前共 15 个 MCP Tools。

## Safety contract

- backend 为 `local-snapshot`，不依赖 Git；
- 私有快照存储在 workspace 外，不返回绝对存储路径；
- `.git`、敏感凭据、`node_modules` 和 Luna runtime logs 被排除，restore 不触碰；
- 单点默认最多 5000 files/directories、128 MiB；每 workspace 最多 20 个；
- create/restore 使用 workspace 独占 mutation gate；
- restore 会还原文件并删除 checkpoint 后新增的普通文件；
- restore 失败自动回到操作前状态，audit 标记 `rolledBack=true`；
- 损坏、跨 workspace、路径逃逸和存储位于 workspace 内的 checkpoint 被拒绝；
- create/restore/delete 都是 approval-protected，list 是 read；
- 快照依赖 OS 用户目录权限，不额外加密。

## Tests

正式 `18765` 端点已通过：

- `npm test`
- `npm run test:mcp`
- `npm run test:admin`
- `npm run test:checkpoint`

覆盖正常恢复、删除后新增文件、敏感/依赖保留、损坏拒绝、注入失败回滚、审计、独占锁，以及 Dashboard approve/deny。

## Web-side verification

桌面端会保留一个 label 为 `v0.4.0 web verification baseline` 的恢复点，并在 workspace 放置 `checkpoint-web-verification.txt`，基线内容为 `baseline-v0.4.0`。

建议：

1. `get_capabilities`：确认 v0.4.0、checkpoint=true、15 tools；
2. `list_checkpoints`：找到上述 label 并记下 id；
3. 把 `checkpoint-web-verification.txt` 改成 `mutated-by-web`；
4. 新建 `checkpoint-created-after.txt`；
5. `restore_checkpoint(id)`；
6. 确认 verification 文件恢复为 baseline，新文件变为 missing；
7. 确认无误后 `delete_checkpoint(id)`。

完成后请把结果写入 workspace 的远端验收文件，下一项将进入 atomic `apply_patch`。
