function action(id, label, level, publicTool, operation, protectedAction = false) {
  return Object.freeze({ id, name: id, label, level, publicTool, operation, protected: protectedAction });
}

// Core actions stay fine-grained so permission, approval and audit decisions never
// inherit the broader risk of an MCP domain tool. Adapters may group these actions.
export const ACTION_DEFINITIONS = Object.freeze([
  action("system.capabilities", "能力发现", "read", "luna.capabilities", "get"),

  action("workspace.list", "浏览目录", "read", "workspace.read", "list"),
  action("workspace.stat", "检查路径版本", "read", "workspace.read", "stat"),
  action("workspace.read_text", "读取文件", "read", "workspace.read", "text"),
  action("workspace.read_range", "分段读取", "read", "workspace.read", "range"),
  action("workspace.search", "搜索文件", "read", "workspace.read", "search"),

  action("workspace.write_text", "整文件写入", "write", "workspace.write", "text", true),
  action("workspace.replace_text", "局部替换", "write", "workspace.write", "replace", true),
  action("workspace.write_many", "安全批量写入", "write", "workspace.write", "many", true),
  action("workspace.mkdir", "创建目录", "write", "workspace.write", "mkdir", true),
  action("workspace.move", "移动路径", "write", "workspace.manage", "move", true),
  action("workspace.delete", "删除路径", "delete", "workspace.manage", "delete", true),

  action("code.apply_patch", "原子应用补丁", "write", "code.patch", "apply", true),

  action("artifact.inspect", "检查二进制文件", "read", "artifact.read", "inspect"),
  action("artifact.export", "导出本地文件", "read", "artifact.read", "export", true),
  action("artifact.import", "导入网页文件", "network", "artifact.import", "import", true),

  action("checkpoint.list", "查看恢复点", "read", "checkpoint.read", "list"),
  action("checkpoint.create", "创建恢复点", "write", "checkpoint.write", "create", true),
  action("checkpoint.restore", "恢复工作区", "write", "checkpoint.write", "restore", true),
  action("checkpoint.delete", "删除恢复点", "delete", "checkpoint.write", "delete", true),

  action("git.status", "查看 Git 状态", "read", "git.read", "status"),
  action("git.diff", "查看 Git 差异", "read", "git.read", "diff"),
  action("git.log", "查看 Git 历史", "read", "git.read", "log"),
  action("git.clone", "克隆公开仓库", "network", "git.remote", "clone", true),

  action("project.execute", "执行工程命令", "execute", "project.execute", "run", true),
  action("project.install_dependencies", "安装项目依赖", "network", "project.dependencies", "install", true)
]);

export const ACTION_BY_ID = new Map(ACTION_DEFINITIONS.map((definition) => [definition.id, definition]));

export const PUBLIC_TOOL_NAMES = Object.freeze([...new Set(
  ACTION_DEFINITIONS.map((definition) => definition.publicTool)
)]);

export function publicToolSummary(policy) {
  const result = {};
  for (const definition of ACTION_DEFINITIONS) {
    const operation = {
      action: definition.id,
      enabled: policy.isActionEnabled(definition.id),
      requiresApproval: policy.requiresApproval(definition.id),
      approvalProtected: definition.protected,
      level: definition.level
    };
    const entry = result[definition.publicTool] ?? {
      enabled: false,
      fullyEnabled: true,
      operations: {}
    };
    entry.operations[definition.operation] = operation;
    entry.enabled ||= operation.enabled;
    entry.fullyEnabled &&= operation.enabled;
    result[definition.publicTool] = entry;
  }
  return result;
}
