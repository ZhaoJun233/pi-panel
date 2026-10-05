# Pi Panel (VS Code 拓展) 修复与优化技术方案 (REPAIR_PLAN.md)

---

## 1. 目标与范围 (Objective & Scope)

### 1.1 背景与目标
`pi-panel` 是用于在 Visual Studio Code 侧边栏/辅助侧边栏中集成并操作 Pi coding agent (`@earendil-works/pi-coding-agent`) 的轻量级 Webview 插件。
经过深度代码审查与 15 项真实异常场景复现，当前版本（0.0.1）在底层协议通信、会话生命周期管理、进程并发控制、消息流归一化及 Webview 前端渲染等方面存在若干关键缺陷，导致“消息重复”、“滚动强跳”、“进程退出污染”、“历史丢内容”等较差体验。

本方案旨在：
1. **解决核心稳定性与协议一致性问题**：对齐 Pi RPC 规范（v0.85+），消除乱码、进程竞争、挂起死锁与数据状态不一致。
2. **彻底修复交互与渲染体验缺陷**：消除全量 DOM 重绘与强行拉底滚动，支持局部增量渲染与安全的代码块/Markdown 格式化。
3. **架构收敛与工程规范化**：保持纯原生 JavaScript、无沉重外部框架依赖的精简优势，建立单测/验证套件与严密的防御机制。

### 1.2 影响范围
- **核心文件**：
  - `extension.js`：涵盖 `PiRpcClient`、`PiPanel`、`PiChatViewProvider` 及 Webview HTML/CSS/Client JS。
  - `package.json`：扩展命令、快捷键、激活事件及配置项。
- **新增工程化文件**：
  - `test/audit_verification.js`：无头/隔离自动化回归验证脚本。
  - `README.md`：规范化项目使用、调试与配置说明。

---

## 2. 现状与影响分析 (Current Architecture & Impact Surface)

### 2.1 架构与执行链路
```text
[VS Code 侧边栏/辅助栏]
         │ (Webview postMessage)
         ▼
 ┌────────────────────────────────────────────────────────┐
 │                      PiPanel                           │
 │  - 维护会话状态、模型列表、目录状态与消息历史         │
 │  - 控制器生命周期协调                                   │
 └──────────────────────────┬─────────────────────────────┘
                            │ (JSON-RPC over stdin/stdout)
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │                    PiRpcClient                         │
 │  - 负责拉起 `pi --mode rpc` 子进程                     │
 │  - 处理严格 JSONL 分割与 pending 请求 Map              │
 └──────────────────────────┬─────────────────────────────┘
                            │ (跨进程 stdio)
                            ▼
      [Node / pi.cmd 子进程 (@earendil-works/pi-coding-agent)]
```

### 2.2 核心缺陷清单与归因分析

| 缺陷编号 | 严重度 | 归因模块与代码位置 | 核心原因及业务影响 |
|---|---|---|---|
| **ISS-01** | **High** | `PiPanel.send()` (L396)<br>`PiPanel._onEvent()` (L241) | **用户提问消息在界面重复显示两遍**：用户点击发送时直接向 `state.messages` 追加了一条；随后接收到 Pi RPC 返回的 `message_start (role: user)` 时再次无条件追加，导致界面上每次发送都会出现重复气泡。 |
| **ISS-02** | **High** | `normalizeMessage()` (L130) | **合法用户消息被渲染为空白**：根据 Pi 规范，`UserMessage.content` 允许为单一 `string` 或 `(TextContent \| ImageContent)[]`。现有代码仅检查 `Array.isArray(msg.content)`，导致纯字符串内容的消息文本被丢弃置空。 |
| **ISS-03** | **High** | `PiPanel.newSession()` (L478) | **新会话失败仍破坏性清空历史**：在发出 RPC 请求前立即清空 `messages` 与工具输出；若该请求被扩展拦截取消（`cancelled: true`）或因进程异常失败，本地历史已永久丢失，且与后端底层状态产生脱节。 |
| **ISS-04** | **High** | `PiPanel.switchDirectory()` (L458)<br>`PiPanel._onEvent('exit')` (L215) | **切换目录发生异步进程事件竞争（Race Condition）**：杀死旧进程后立即启动新进程，但旧进程异步派发的 `exit` 事件仍被同一个主控制器接收，直接将新进程的就绪状态覆写为 `error`。 |
| **ISS-05** | **High** | `PiRpcClient._onData()` (L65) | **UTF-8 字符跨缓冲区截断乱码**：直接使用 `buffer += d.toString()`，当中文多字节字符（如 3 字节 UTF-8）恰好被底层的 chunk 切分在两次 data 事件时，`toString()` 会立即生成非法字符 `\uFFFD`，导致乱码。 |
| **ISS-06** | **High** | `PiRpcClient.send()` (L96)<br>`PiRpcClient.start()` (L54) | **RPC 挂起句柄未清理导致内存泄漏与死锁**：缺少请求超时机制；进程 `exit` 或 `spawn_error` 时没有遍历清空 `pending` Map 并执行 `reject`，导致上层等待的 Promise 永不完结。 |
| **ISS-07** | **Medium** | Webview `render()` (L756, L803) | **每次 token 增量都全量重绘 DOM 且强行拉底**：前端收到每条 `state` 更新都重建全部消息的 HTML，导致打字过程中高频重绘闪烁、选中文字丢失、卡片折叠状态重置，且通过 `scrollTop = scrollHeight` 强制拉底，阻碍用户向上翻看历史。 |
| **ISS-08** | **Medium** | `_onEvent('tool_execution_update')` (L319)<br>`PiPanel.init()` (L528) | **工具执行过程缺失动态反馈，历史输出丢失**：增量输出未绑定到前端渲染卡片；加载历史消息时直接过滤丢弃了 `role: toolResult`，导致后续加载会话时之前的命令输出全部消失。 |
| **ISS-09** | **Medium** | Webview HTML `basename()` (L751) | **Windows 路径反斜杠转义错误**：内联脚本在模板字符串中定义正则表达式 `replace(/[\\/]+$/, '').split(/[\\/]/)`，因外层模板字符串未对反斜杠做转义，导致在浏览器中变成了 `/[/]+$/`，Windows 盘符路径无法提取出正确的目录短名称。 |
| **ISS-10** | **Medium** | Webview 按钮与键盘绑定 (L759, L856) | **发送逻辑与快捷键状态脱节**：流式传输期间虽然禁用了发送按钮，但未在 `ta.addEventListener('keydown')` 中拦截，按 Enter 仍可触发发送；而在启动与错误状态下反而允许点击按钮。 |
| **ISS-11** | **Low** | `PiChatViewProvider` (L577) | **多视图上下文互相覆盖**：插件同时在主侧边栏 (`piChatView`) 和辅助侧边栏 (`piChatViewAux`) 注册，但 `PiPanel` 内部只维护了单一 `this.webviewView` 引用，后打开或后展示的视图会覆盖前者，导致前一个面板失去更新。 |

---

## 3. 核心设计与数据流规范 (API Contracts & Architecture Design)

### 3.1 编码层与流分块协议 (`StringDecoder`)
严格保障 UTF-8 多字节字符流在跨 chunk 拼接时的完整性：
```javascript
const { StringDecoder } = require('string_decoder');

class PiRpcClient {
  constructor(cwd, onEvent) {
    this.cwd = cwd;
    this.onEvent = onEvent;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    // ...
  }
  _onData(d) {
    this.buffer += this.decoder.write(d);
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handle(msg);
      } catch (err) {
        // 记录格式异常但不破坏缓冲区循环
      }
    }
  }
}
```

### 3.2 进程代次管理 (Epoch / Generation Token)
为每一次子进程实例绑定唯一的 `epochId`。所有跨进程消息、退出回调、错误派发必须经过代次校验，彻底消除“旧进程退出污染新进程状态”的时序竞争：
```text
switchDirectory(newPath):
  1. epoch = ++this.currentEpoch;
  2. oldClient = this.client;
  3. oldClient.stop();
  4. newClient = new PiRpcClient(newPath, (evt) => {
       if (this.currentEpoch !== epoch) return; // 拦截旧代次事件
       this._onEvent(evt);
     });
```

### 3.3 消息双端生命周期与乐观更新状态机
消除用户消息重复追加与乱序：
```text
[用户触发发送]
      │
      ▼
本地插入一条临时用户消息 { id: 'pending-xxx', role: 'user', text, status: 'pending' }
      │
      ▼
发送 prompt RPC 请求
      │
      ├─► 收到 message_start (role: user) ──► 匹配并更新该临时消息的权威 ID 与 timestamp
      │
      └─► 收到 message_end (role: user)   ──► 固化为最终形态，更新 status: 'done'
```

### 3.4 工具执行数据流与历史回填
`ToolResultMessage` 不再被过滤，而是作为执行输出挂载在对应的 `ToolCall` 节点中：
- 接收 `tool_execution_start`：记录 `toolCallId`，将对应卡片置为 `running`。
- 接收 `tool_execution_update`：直接将 `partialResult`（Pi 规范中包含截至目前的累计输出）更新到该 `toolCallId` 的视图并局部刷新。
- 接收 `tool_execution_end`：置为 `done`。
- 初始化历史（`get_messages`）：先收集全部 `toolResult` 构建 `Map<toolCallId, output>`，再遍历 `assistant` 消息填充至对应的 `toolCalls[i].output`。

### 3.5 Webview 局部更新与智能滚动设计
- **智能滚动检测**：
  ```javascript
  const isNearBottom = () => {
    const threshold = 60;
    return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight <= threshold;
  };
  ```
  只有在用户本身位于底部附近（`isNearBottom() === true`）时，新消息到达才执行平滑或直接拉底；用户向上回滚时保持当前滚动位置，并显示“有新消息到达”悬浮提示。
- **DOM 局部更新**：
  历史消息渲染后带有属性 `data-msg-id`。流式阶段仅修改最后一个 Assistant 容器的文本内容与思考区，不再销毁重排整棵 DOM 树。

---

## 4. 分步骤实施清单 (Step-by-Step Milestones)

### 阶段一：RPC 协议层加固 (`PiRpcClient`)
- [x] **M1.1 编码修复**：集成 `StringDecoder`，修复 UTF-8 中文多字节切片乱码。
- [x] **M1.2 异常与超时治理**：为 `send()` 引入超时控制（默认 30 秒，可针对 prompt 特殊处理）；在进程退出（`exit`）及报错时遍历并拒绝（`reject`）全部未决请求，清空 `pending` Map。
- [x] **M1.3 进程安全退出**：Windows 平台支持树形强制销毁保障，避免僵尸进程。

### 阶段二：控制器与状态机修复 (`PiPanel`)
- [x] **M2.1 引入 Epoch 机制**：重构 `switchDirectory()` 与 `start()`，隔离不同代次进程的事件。
- [x] **M2.2 会话切换原子性**：重写 `newSession()`，等待 RPC 明确成功且 `data.cancelled !== true` 后再执行本地视图和历史重置。
- [x] **M2.3 消息归一化扩充**：`normalizeMessage()` 增加对 `typeof content === 'string'` 的正规解析；保留 `errorMessage` 与 `stopReason` 并上屏展示。
- [x] **M2.4 状态同步与刷新**：在 `get_state` 成功返回后，若当前处于 `starting` 状态，自动回正为 `idle`；并在每次 `agent_settled` 后自动拉取最新的 `get_session_stats` 刷新 Context 状态。
- [x] **M2.5 工具历史数据持久化**：重写 `init()` 中对 `get_messages` 的处理，正确将 `toolResult` 关联到对应的 `toolCall`。

### 阶段三：Webview 前端体验与健壮性改造
- [x] **M3.1 路径解析修复**：修正客户端内联 JavaScript 中的正则表达式转义问题，确保 Windows 盘符路径能准确展示目录名称。
- [x] **M3.2 交互逻辑与键盘校验统一**：在 `keydown` 事件中同步校验 `status !== 'idle'`，阻止在未就绪或生成中的不合规发送。
- [x] **M3.3 智能按需滚动与局部渲染**：实现 DOM 局部差量填充，移除全量 `innerHTML` 暴力重排，加入 `isNearBottom` 视口保护。
- [x] **M3.4 基础排版与 Markdown 代码高亮优化**：引入安全轻量的代码块格式化支持，提供一键复制代码块能力。

### 阶段四：多视图架构与 VS Code 契约完善
- [x] **M4.1 多 Webview 同步机制**：将 `PiPanel.webviewView` 改为 `Set<WebviewView>`，在主侧边栏与辅助侧边栏同时挂载时，向所有活动视图统一广播状态变更。
- [x] **M4.2 命令与空状态文案对齐**：修正空状态文案中对不支持命令的误导提示，增加规范的快捷操作引导。

---

## 5. 边界情况与风险预案 (Edge Cases & Risk Mitigation)

| 场景分类 | 边缘情况 | 应对预案 |
|---|---|---|
| **网络与进程** | 用户快速连续切换不同的工作目录 | 每次切换强制使前一次 `epoch` 失效，立即终止旧子进程；若旧子进程阻塞无响应，3 秒后执行强制终结。 |
| **超长输出** | 工具调用（如 `git log` 或 `find`）产生数十万行超长文本 | 前端对单次工具输出执行上限截断（如保留前 1000 行），提供“在编辑器中查看全部”链接，避免 Webview 崩溃。 |
| **安全防御** | 模型返回包含恶意 HTML 注入脚本 | 严格遵循现有的 CSP 策略（`default-src 'none'; script-src 'nonce-...';`），所有消息内容渲染强制经过转义函数 `esc()`。 |
| **并发冲突** | 在 Agent 思考中用户再次输入内容 | 利用 Pi RPC 提供的 `streamingBehavior: "steer"` 或 `"followUp"` 规范，明确向用户显示“排队中/插话中”指示，而不是直接吞没或报错。 |

---

## 6. 验证与回归测试策略 (Verification & Regression Strategy)

### 6.1 自动化隔离回归测试
在代码库中设立 `test/audit_verification.js`，通过 Node.js 隔离沙箱模拟 Mock 子进程和 VS Code Webview 通信，实现零真实 API 消耗、无副作用的断言验证：

```bash
# 验证套件执行命令 (在 E:\plugin\piVscode 目录下)
node test/audit_verification.js
```

**必须覆盖的断言验证项：**
1. **UTF-8 边界切片测试**：模拟一个中文字符被截断在两个 Buffer chunk 中发送，断言最终收到的文本完全正常无 `\uFFFD`。
2. **提问去重测试**：模拟一次 prompt 发送及完整的 `message_start`、`message_end` 事件，断言 `state.messages` 仅保留一条用户消息记录。
3. **字符串正文测试**：传入 `{ role: 'user', content: 'hello' }`，断言解析出的 `ui.text === 'hello'`。
4. **新会话失败回滚测试**：模拟 `new_session` 返回 `cancelled: true` 或抛错，断言之前的 `messages` 历史完好保留。
5. **进程切换竞争测试**：快速连续切换两次目录，模拟第 1 个进程滞后触发 `exit`，断言当前状态依然保持正常，不被旧事件破坏。
6. **未决请求清理测试**：发出 RPC 请求未获得响应时触发进程 `exit`，断言对应 Promise 立即被拒绝，无未决泄露。
7. **滚动保护测试**：模拟用户滚动条处于顶部，触发增量渲染，断言 `scrollTop` 不会被强行拉回底部。

### 6.2 VS Code 宿主集成测试
1. 在 VS Code 中使用 `F5`（Extension Development Host）启动调试。
2. 打开“Pi”侧边栏面板，检查初始化状态是否平滑进入 `idle`，目录下拉列表中是否准确显示工程名称（而非完整长路径）。
3. 发送包含中文字符的长提问，确认无重复消息气泡、无打字中页面闪烁或向上滚动被拉回问题。
4. 触发多步工具调用（如搜索代码、执行终端命令），确认工具卡片在执行中有动态指示，执行完毕有正确结果。
5. 执行“新会话”并快速取消，验证界面历史是否保持稳定。
