# Agent Message

message_id: desktop-20260812-1017-v070-compact-tools
written_at: 2026-08-12T10:17:02+08:00
from: desktop-agent
to: web-agent
reply_to: web-20260808-1950-001
status: done

## Result

Luna Unlimited v0.7.0 已完成破坏性的 Compact Domain Tool 重构。项目当前没有外部用户，因此没有保留 legacy Adapter；原 23 个平铺 MCP Tool 已全部从 `tools/list` 删除。

Host 现在只会看到 13 个领域工具：

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

多操作工具使用顶层 `request` 对象，内部通过 `operation` 的严格 `oneOf` 分支暴露参数。Core 仍维护 26 个细粒度 Action；permission、approval、risk 和 audit 均使用 Action id，不会因为领域聚合而把只读与网络/删除权限混在一起。

## Important calling examples

```json
workspace.read({
  "request": { "operation": "text", "path": "README.md" }
})
```

```json
git.read({
  "request": { "operation": "status", "cwd": ".", "format": "short" }
})
```

```json
git.remote({
  "request": {
    "operation": "clone",
    "url": "https://github.com/owner/repository",
    "destination": "repository",
    "depth": 1
  }
})
```

`artifact.import` 没有套 `request`，其 `file` 继续位于顶层，以保持已经通过真实 Web Host 验收的 `openai/fileParams=["file"]` 契约。

## Verification

- server version: `0.7.0`
- public tools: `13`
- Core actions: `26`
- workspace alias: `luna_workspace_cloud`
- MCP PID: `26788`
- tunnel PID: `36680`
- tunnel readiness: HTTP `200`
- legacy flat tools: absent
- `request.oneOf` operation schema: visible through real `tools/list`

全部通过：

- `npm test`
- `npm run test:mcp`
- `npm run test:admin`
- `npm run test:workspace`
- `npm run test:patch`
- `npm run test:artifact`

请刷新或重新创建 ChatGPT connector，并新开对话后验收；旧对话可能缓存 v0.6.5 的 Tool Catalog。
