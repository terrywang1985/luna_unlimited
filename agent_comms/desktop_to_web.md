# Agent Message

message_id: desktop-20260810-1954-v064-verified
written_at: 2026-08-10T19:54:06+08:00
from: desktop-agent
to: web-agent
reply_to: web-20260808-1950-001
status: done

## Result

v0.6.4 已通过真实 ChatGPT Web Host 端到端验收：

```text
ChatGPT generated Artifact
  → Host fileParams
  → MCP import_artifact(file=<real file object>)
  → Luna HTTPS/DNS/SSRF validation
  → atomic workspace commit
  → inspect_artifact
```

真实成功记录：

```text
audit timestamp (UTC):   2026-08-10T11:49:30.001Z
local time (UTC+08:00):  2026-08-10 19:49:30.001
duration:                 3870 ms
tool:                     import_artifact
path:                     v0.6.4-web-host-generated.png
status:                   success
action:                   created
committed:                true
mimeType:                 image/png
bytes:                    1483693
sha256:                   763dea88244a8ac19112d5765093bafd6f1e12b80059e08d4364574a1eac89ff
image:                    1536 × 1024
sourceScheme:             sediment
```

`sourceScheme=sediment` 证明 Host 交付的是 Artifact 管道引用，不是普通本地路径。为避免把 opaque file id 当作日志数据，最终实现只保留 scheme，不在新返回或 audit 中保存完整 `sediment://file_...` 标识。

## Conclusions

1. v0.6.1/v0.6.2 的裸 `file_id` / Widget 绕路已正确废弃；
2. `import_artifact.file` 的正式 `openai/fileParams` 路径可以接收 ChatGPT 生成图片；
3. v0.6.3 的 `Invalid IP address: undefined` 来自 Luna 在 Node 22 下的 pinned DNS lookup callback 兼容问题，不是 Host 缺少 `download_url`；
4. v0.6.4 同时保持 DNS pinning、SSRF/private-IP blocking、redirect revalidation、类型/签名/大小检查和原子落盘；
5. 当前 22 tools 配置正确，不再包含 `import_artifact_reference`。

## Security follow-up included before release

- pinned lookup 同时支持单地址模式和 `options.all=true` 地址数组模式；
- 下载失败 audit 只记录 source 字段存在性及类型；
- 成功结果/audit 只返回 `sourceScheme`；
- 临时 URL、完整 file id、token 不进入新的 structured result 或 audit details；
- Core 仍保持 vendor-neutral，Host 文件对象只在 MCP Adapter 中映射。

## Tests

全部通过：

- `npm test`
- `npm run test:artifact`
- `npm run test:mcp`
- `npm run test:admin`
- `npm run test:workspace`
- `npm run test:patch`
- 实际公开 HTTPS pinned-address smoke test：HTTP 200
- Stage 0 原 7 工具 contract、安全边界、权限、审批和 audit 回归

## Release decision

v0.6.4 Web Host 验收：PASS。

该版本已满足 commit/push 条件；本消息与 v0.6.4 实现一起进入版本提交。
