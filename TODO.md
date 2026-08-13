# Luna Unlimited · 后续迭代 TODO

> 基线版本：v0.8.0（2026-08-13）
>
> 当前里程碑：**可靠工程编辑闭环**。任意兼容 Host 已能在单个授权 workspace 内完成 capability discovery、代码读取与搜索、带 revision 的原子修改、依赖安装、构建/测试、checkpoint/restore，以及 Artifact 双向传输。这个基线已经能够支持人工发起、Agent 持续调用工具的中等规模工程开发。

这份文件记录可执行的近期工作；[AGENT_CAPABILITIES_ROADMAP.md](AGENT_CAPABILITIES_ROADMAP.md) 继续负责长期架构原则。完成事项必须同步代码、测试、Dashboard、capability 与文档，不能只增加一个 MCP Tool。

## 已完成的里程碑

- [x] Stage 0：锁定原有 7 个工具的外部 contract、安全、审批与审计行为。
- [x] Milestone A：Core / Adapter 解耦，Core 不依赖 MCP SDK。
- [x] Milestone B：可靠编辑原语，包括 SHA-256 冲突保护、原子 `write_files` 和 `apply_patch`。
- [x] v0.4.0：非 Git `local-snapshot` checkpoint / restore。
- [x] v0.6.0：目录创建、移动、受保护删除和 Artifact 双向传输。
- [x] v0.6.4：正式 Host `fileParams` 导入链路、DNS pinning 与 Node 22 HTTPS 兼容。
- [x] v0.6.5：受限公开 GitHub `clone_repository`，包含无凭据 HTTPS、DNS/Host 策略、临时目录校验、大小限制、原子提交、审批和审计。
- [x] v0.7.0：破坏性 Compact Domain Tool 重构。公开 MCP Tool 从 23 个收敛为 13 个，旧平铺 Tool 全部删除；26 个细粒度 Core Action 独立承载 permission、approval、risk 和 audit；多操作 Schema 通过 `request.oneOf` 对 Host 可见。
- [x] v0.8.0：新增显式 `restricted / user / container-root / host-root` 执行档位与 `system.execute`。restricted 不能被 Dashboard 绕过；root 档位验证 Linux UID/容器边界；系统命令始终强制本地逐次审批，审计仅保存命令 hash 和脱敏元数据。

## v0.8.x · 持久安全策略与项目任务

目标：重启后权限不漂移，并让工程命令来自本机可信策略，而不是仅依赖 Agent 可修改的项目脚本。

- [ ] 实现 workspace 外的 `PolicyStore`，在 Luna 私有状态目录保存 versioned policy。
- [ ] 使用临时文件、flush 和原子 rename 持久化；损坏或未知版本配置必须 fail closed。
- [ ] 权限、审批模式和 command policy 统一从 Core PolicyStore 读取。
- [ ] 每次有效变更递增 `policyRevision`，Dashboard 展示版本、revision、加载状态和错误。
- [ ] 定义 `read / write / build / network / system` 风险等级。
- [ ] 将 npm 等可变 manifest 脚本视为 workspace 可变代码；记录 manifest hash，变更后重新审批。
- [ ] 增加本机受保护的 project task 定义和 `run_project_command`，让常用低风险任务无需使用高权限 `system.execute`。
- [ ] 增加 migration、损坏配置、原子写失败、权限重启恢复及 mutable manifest 绕过测试。

完成标准：

> 服务重启后权限和审批状态保持一致；无效配置安全降级；Agent 只能执行本机 policy 明确授权且可审计的项目任务，不能通过修改 `package.json` 绕过策略。

## v0.9 · 长期进程与本地服务调试

目标：补齐“启动项目 → 观察输出 → 调接口 → 修改 → 重试”的开发循环。

- [ ] 实现 `start_process`、`list_processes`、`get_process`、`read_process_output`、`stop_process`。
- [ ] 默认只允许启动 v0.8.x 中授权的 project task；如复用 `system.execute`，必须继承其执行档位、强制审批与审计约束。
- [ ] Luna 只能管理自己启动的进程，并记录 owner session、PID、task revision 和 cwd。
- [ ] 增加 TTL、并发上限、输出环形缓冲、输出截断、超时和退出状态。
- [ ] Luna 退出时采用明确的子进程清理策略，异常重启后识别并处理孤儿状态。
- [ ] Dashboard 展示运行进程、持续时间、最近输出和停止入口。
- [ ] 增加仅允许 `127.0.0.1` / `localhost` 的 `http_request`；公网访问使用独立 policy，默认关闭。
- [ ] 覆盖端口占用、输出洪泛、超时、越权 stop、进程树清理和 localhost SSRF 测试。

完成标准：

> Agent 可以安全启动开发服务器、读取日志、请求本地接口、修改代码后重新验证，并且不能管理 Luna 之外的系统进程或访问未授权网络。

## v0.10 · 结构化文档与媒体处理

目标：从“可靠传输二进制文件”升级到“在 workspace 内可靠读取、生成和修改常见办公文件”。

- [ ] 设计可选 Processor 接口，格式处理库不进入 Core 权限判断层。
- [ ] Excel：工作簿/工作表探测、范围读取、单元格与公式写入、样式保留、输出校验。
- [ ] PDF：文本与元数据提取、逐页渲染、页面选择、生成与合并；扫描件 OCR 作为可选能力。
- [ ] 图片：尺寸/格式检查、转换、缩放、裁剪和压缩；保留原图并使用新 revision 输出。
- [ ] 所有生成物复用 Artifact import/export、大小限制、MIME/签名校验和原子落盘。
- [ ] Dashboard 展示 Processor 能力、依赖状态、输入/输出摘要与失败原因。
- [ ] 使用真实 XLSX、PDF、PNG/JPEG fixture 做 round-trip、损坏文件、zip bomb 和资源上限测试。

完成标准：

> Agent 能在不把真实绝对路径或秘密暴露给 Host 的前提下，读取和修改常见 Excel、提取/渲染 PDF、处理图片，并把校验后的结果导出回 Host。

## v0.11 · 多 workspace、会话与可观测性

目标：让多个项目和多个 Agent 可控共存，同时保持单一 Core 安全模型。

- [ ] 增加本机预授权 workspace profile；远端只能按安全别名选择，不能提交任意绝对路径。
- [ ] 定义 `CallerContext` / `WorkSessionContext` 的持久审计关联，但 caller 自报身份不影响权限。
- [ ] 增加结构化 audit 查询、按 session/tool/path/status 过滤和敏感字段脱敏。
- [ ] 增加可选 path lease/lock；默认仍使用 revision 的 optimistic concurrency。
- [ ] 增加 `get_project_context`、`detect_project` 和结构化 build/test diagnostics。
- [ ] 建立不同 MCP Host/SDK 版本的兼容矩阵与端到端回归。
- [ ] 明确 workspace 切换时 checkpoint、process、approval 和 audit 的隔离规则。

完成标准：

> 用户可在 Dashboard 预授权多个项目，多个 Host/Agent 能按别名工作并通过 revision、session 和审计定位冲突，任何远端调用者都不能自行扩大 workspace 或权限。

## 持续质量与发布工作

- [ ] 每个版本维护升级说明、配置迁移和回滚步骤。
- [ ] 在 CI 中运行 contract、architecture、checkpoint、patch、artifact 与 security tests。
- [ ] 增加 Windows 干净环境安装、幂等启动、Tunnel 断线重连和异常退出测试。
- [ ] 为 Dashboard、错误码、Tool schema 和 capability response 增加稳定性测试。
- [ ] 建立真实 Host 验收清单，区分 Core、Adapter、Tunnel 和 Host UI 问题。
- [ ] 发布前执行依赖与许可证检查，并记录第三方二进制来源和校验方式。

## 暂不纳入默认能力

以下能力只有在独立 policy、显式本机授权和完整审计具备后才评估，不能为了“更像桌面 Agent”直接开放：

- 默认或静默开放 PowerShell、cmd、bash 或 `shell=true`；显式系统执行档位下只能逐次本地审批；
- 自动 Git push、force push、远端/凭据修改；
- 任意公网访问和任意软件下载；
- 读取 `.env`、SSH key、浏览器 Cookie、Tunnel credential 等秘密；
- 管理 Luna 未启动的系统进程；
- 由远端 Agent 关闭审批、修改 workspace root 或提升自身权限。

## 执行纪律

每个复选项真正完成前至少需要：

1. Core implementation 与统一 error code；
2. path、policy、approval 和 risk classification；
3. audit 与敏感字段脱敏；
4. Adapter exposure 与 capability 更新；
5. Dashboard 可见性（适用时）；
6. positive、negative、security 和 rollback 测试；
7. README、安装教程与本 TODO 同步；
8. 真实 Host 验收通过后再标记完成。
