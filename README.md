# Pi Panel for VS Code (`pi-panel`)

在 Visual Studio Code 侧边栏/辅助侧边栏中直接使用 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)（基于 `pi --mode rpc`）。

## 目录结构

```text
E:\plugin\piVscode\
├── .gitignore               # Git 忽略配置
├── extension.js             # 插件核心逻辑（RPC Client、Panel 控制器、Webview HTML）
├── package.json             # 扩展清单与命令定义
├── media\
│   └── pi-icon.svg          # 插件活动栏图标
├── test\
│   └── audit_verification.js # 自动化无头回归验证测试套件
└── REPAIR_PLAN.md           # 深度修复与体验优化技术方案文档
```

## 修复与优化方案

详细技术方案与分步骤实施清单见：[REPAIR_PLAN.md](./REPAIR_PLAN.md)。

已完成核心加固项：
- **RPC 协议层**：基于 `StringDecoder` 修复 UTF-8 跨 Buffer chunk 乱码；引入请求超时控制，进程退出/停止时原子清理未决请求；Windows 平台进程树安全终结。
- **控制器与状态机**：引入 Epoch 代次管理，彻底隔离多目录切换时的异步进程竞争；实现 `newSession` 失败回滚保护；支持用户消息正文为纯字符串的规范解析；消息双端生命周期对齐与去重；工具执行动态更新与历史会话输出关联；完成会话后自动刷新 Context 统计。
- **Webview 交互与体验**：修正 Windows 盘符路径提取正则；发送按钮与 Enter 快捷键状态双向同步绑定；智能视口滚动保护（向上翻阅历史消息时不强跳底部）；DOM 增量差异渲染杜绝闪烁；支持轻量安全的 Markdown 排版与代码块一键复制。
- **多视图架构**：主侧边栏与辅助侧边栏多 Webview 实例统一状态广播，避免视图互相覆盖。

### 运行自动化缺陷验证
在项目根目录下执行：
```bash
node test/audit_verification.js
```
该测试基于纯 Node.js 沙箱环境运行，包含 11 项端到端及契约断言，无需真实启动 Pi 进程或消耗大模型 Token。
