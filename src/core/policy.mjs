export const TOOL_DEFINITIONS = Object.freeze([
  { name: "get_capabilities", label: "能力发现", level: "read" },
  { name: "list_directory", label: "浏览目录", level: "read" },
  { name: "stat_path", label: "检查路径版本", level: "read" },
  { name: "read_text_file", label: "读取文件", level: "read" },
  { name: "read_text_file_range", label: "分段读取", level: "read" },
  { name: "search_files", label: "搜索文件", level: "read" },
  { name: "write_text_file", label: "整文件写入", level: "write" },
  { name: "replace_text", label: "局部替换", level: "write" },
  { name: "write_files", label: "安全批量写入", level: "write" },
  { name: "create_checkpoint", label: "创建恢复点", level: "write" },
  { name: "list_checkpoints", label: "查看恢复点", level: "read" },
  { name: "restore_checkpoint", label: "恢复工作区", level: "write" },
  { name: "delete_checkpoint", label: "删除恢复点", level: "write" },
  { name: "exec_command", label: "执行命令", level: "execute" },
  { name: "install_dependencies", label: "安装项目依赖", level: "execute" }
]);

export const PROTECTED_TOOLS = Object.freeze([
  "write_text_file",
  "replace_text",
  "write_files",
  "create_checkpoint",
  "restore_checkpoint",
  "delete_checkpoint",
  "exec_command",
  "install_dependencies"
]);

export class PolicyService {
  constructor({ approvalTimeoutSeconds = 120 } = {}) {
    this.toolPermissions = Object.fromEntries(TOOL_DEFINITIONS.map(({ name }) => [name, true]));
    this.approvalEnabled = false;
    this.approvalTimeoutSeconds = approvalTimeoutSeconds;
    this.protectedTools = new Set(PROTECTED_TOOLS);
    this.version = 1;
    this.revision = 0;
  }

  hasTool(tool) {
    return Object.hasOwn(this.toolPermissions, tool);
  }

  isToolEnabled(tool) {
    return this.toolPermissions[tool] === true;
  }

  setToolEnabled(tool, enabled) {
    if (!this.hasTool(tool)) return false;
    this.toolPermissions[tool] = enabled;
    this.revision += 1;
    return true;
  }

  setApprovalEnabled(enabled) {
    this.approvalEnabled = enabled;
    this.revision += 1;
  }

  requiresApproval(tool) {
    return this.approvalEnabled && this.protectedTools.has(tool);
  }

  permissionRows() {
    return TOOL_DEFINITIONS.map((definition) => ({
      ...definition,
      enabled: this.isToolEnabled(definition.name)
    }));
  }

  snapshot() {
    return {
      version: this.version,
      revision: this.revision,
      approvalEnabled: this.approvalEnabled,
      approvalTimeoutSeconds: this.approvalTimeoutSeconds,
      protectedTools: [...this.protectedTools],
      permissions: { ...this.toolPermissions }
    };
  }
}
