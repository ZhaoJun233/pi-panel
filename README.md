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

### 运行自动化缺陷验证
在项目根目录下执行：
```bash
node test/audit_verification.js
```
该测试基于纯 Node.js 沙箱环境运行，无需真实启动 Pi 进程或消耗大模型 Token。
