// Pi Panel — 在 VS Code 侧边栏以聊天面板使用 Pi coding agent。
// 通过 `pi --mode rpc` 的 JSONL 协议与 Pi 子进程通信，无第三方依赖。
// 协议参考：@earendil-works/pi-coding-agent/docs/rpc.md

const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Pi RPC client（严格 JSONL，只按 \n 切分）
// ---------------------------------------------------------------------------
class PiRpcClient {
  constructor(cwd, onEvent) {
    this.cwd = cwd;
    this.onEvent = onEvent;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.seq = 0;
  }

  // 复用本地全局环境中的 pi：优先 npm 全局 bin 的 pi.cmd（已验证存在），
  // 否则回退到 PATH 中的 `pi`。绝不捆绑或自动安装运行时。
  resolveCommand() {
    if (process.platform === 'win32') {
      const apdata = process.env.APPDATA;
      if (apdata) {
        const candidate = path.join(apdata, 'npm', 'pi.cmd');
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          /* ignore */
        }
      }
    }
    return 'pi';
  }

  start() {
    const cmd = this.resolveCommand();
    const isWin = process.platform === 'win32';
    const child = spawn(cmd, ['--mode', 'rpc'], {
      cwd: this.cwd,
      shell: isWin, // Windows 下 .cmd 需经 shell 解析
      windowsHide: true,
      env: process.env,
    });
    this.child = child;

    child.stdout.on('data', (d) => this._onData(d));
    child.stderr.on('data', (d) => this.onEvent({ type: 'stderr', text: d.toString() }));
    child.on('exit', (code, signal) => this.onEvent({ type: 'exit', code, signal }));
    child.on('error', (err) =>
      this.onEvent({
        type: 'spawn_error',
        message: err.message,
        command: cmd,
        hint: err.code === 'ENOENT' ? `找不到命令 "${cmd}"，请确认已安装 pi 并在 PATH 中。` : undefined,
      })
    );
  }

  _onData(d) {
    this.buffer += d.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg);
        else p.reject(new Error(msg.error || `命令 ${msg.command} 失败`));
      }
      this.onEvent(msg);
      return;
    }
    this.onEvent(msg);
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      if (!cmd.id) cmd.id = 'r' + ++this.seq;
      this.pending.set(cmd.id, { resolve, reject });
      const line = JSON.stringify(cmd) + '\n';
      try {
        this.child.stdin.write(line);
      } catch (e) {
        this.pending.delete(cmd.id);
        reject(e);
      }
    });
  }

  sendUiResponse(id, payload) {
    try {
      this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id, ...payload }) + '\n');
    } catch {
      /* ignore */
    }
  }

  stop() {
    try {
      this.child && this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// UI 状态与消息归一化
// ---------------------------------------------------------------------------
function normalizeMessage(msg) {
  // AgentMessage -> UI 消息
  const content = Array.isArray(msg.content) ? msg.content : [];
  const ui = {
    role: msg.role,
    text: '',
    thinking: '',
    toolCalls: [],
    done: true,
  };
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') ui.text += block.text || '';
    else if (block.type === 'thinking') ui.thinking += block.thinking || '';
    else if (block.type === 'toolCall') {
      ui.toolCalls.push({
        id: block.id || '',
        name: block.name || block.toolName || 'tool',
        args: JSON.stringify(block.arguments ?? block.input ?? {}),
        output: '',
      });
    } else if (block.type === 'toolResult') {
      const text = (Array.isArray(block.content) ? block.content : [])
        .map((c) => (c && c.text) || '')
        .join('\n');
      ui.toolCalls.push({ id: block.toolUseId || '', name: 'toolResult', args: '', output: text });
    }
  }
  return ui;
}

function blockToUiMessage(blocks) {
  const ui = { role: 'assistant', text: '', thinking: '', toolCalls: [], done: false };
  blocks.forEach((b) => {
    if (!b) return;
    if (b.type === 'text') ui.text += b.text || '';
    else if (b.type === 'thinking') ui.thinking += b.thinking || '';
    else if (b.type === 'toolcall') {
      ui.toolCalls.push({ id: b.id || '', name: b.name || 'tool', args: b.args || '', output: '' });
    }
  });
  return ui;
}

// ---------------------------------------------------------------------------
// 主控制器
// ---------------------------------------------------------------------------
class PiPanel {
  constructor() {
    this.client = null;
    this.webviewView = null;
    this.state = {
      status: 'idle', // starting | idle | streaming | error
      statusText: '',
      model: '',
      thinkingLevel: '',
      availableLevels: [],
      workspaceName: '',
      models: [],
      directories: [],
      contextUsage: null,
      messages: [],
      curAssistant: null, // { blocks: [] }
      toolOutputs: new Map(), // toolCallId -> output text
    };
  }

  start(cwd) {
    if (this.client) return;
    this.state.status = 'starting';
    this.state.statusText = '正在启动 Pi…';
    this._push();
    this.client = new PiRpcClient(cwd, (evt) => this._onEvent(evt));
    this.client.start();
  }

  _onEvent(evt) {
    switch (evt.type) {
      case 'spawn_error': {
        this.state.status = 'error';
        this.state.statusText = evt.hint || evt.message;
        this.state.errorDetail = `${evt.message} (${evt.command})`;
        this._push();
        break;
      }
      case 'exit': {
        if (this.state.status !== 'error') {
          this.state.status = 'error';
          this.state.statusText = `Pi 进程已退出 (code=${evt.code})`;
        }
        this._push();
        break;
      }
      case 'response': {
        if (evt.command === 'get_state' && evt.success && evt.data) {
          const m = evt.data.model;
          this.state.model = m ? `${m.provider}/${m.id}` : '';
          this.state.thinkingLevel = evt.data.thinkingLevel || '';
        }
        break;
      }
      case 'agent_start':
        this.state.status = 'streaming';
        this.state.statusText = 'Pi 思考中…';
        this._push();
        break;
      case 'agent_settled':
        this.state.status = 'idle';
        this.state.statusText = '';
        this._push();
        break;
      case 'message_start': {
        const role = evt.message && evt.message.role;
        if (role === 'user') {
          this.state.messages.push(normalizeMessage(evt.message));
          this._push();
        } else if (role === 'assistant') {
          this.state.curAssistant = { blocks: [] };
        }
        break;
      }
      case 'message_update': {
        if (!this.state.curAssistant) this.state.curAssistant = { blocks: [] };
        const ev = evt.assistantMessageEvent;
        if (!ev) break;
        const blocks = this.state.curAssistant.blocks;
        const idx = typeof ev.contentIndex === 'number' ? ev.contentIndex : blocks.length;
        if (ev.type === 'text_delta') {
          const b = (blocks[idx] = blocks[idx] || { type: 'text', text: '' });
          b.text += ev.delta || '';
        } else if (ev.type === 'text_start') {
          blocks[idx] = blocks[idx] || { type: 'text', text: '' };
        } else if (ev.type === 'thinking_delta') {
          const b = (blocks[idx] = blocks[idx] || { type: 'thinking', thinking: '' });
          b.thinking += ev.delta || '';
        } else if (ev.type === 'thinking_start') {
          blocks[idx] = blocks[idx] || { type: 'thinking', thinking: '' };
        } else if (ev.type === 'toolcall_start') {
          blocks[idx] = blocks[idx] || { type: 'toolcall', id: '', name: '', args: '' };
        } else if (ev.type === 'toolcall_delta') {
          const b = (blocks[idx] = blocks[idx] || { type: 'toolcall', id: '', name: '', args: '' });
          b.args += ev.delta || '';
        } else if (ev.type === 'toolcall_end') {
          const tc = ev.toolCall || {};
          blocks[idx] = {
            type: 'toolcall',
            id: tc.id || '',
            name: tc.name || tc.toolName || 'tool',
            args: JSON.stringify(tc.arguments ?? tc.input ?? {}),
          };
        } else if (ev.type === 'text_end' || ev.type === 'thinking_end') {
          blocks[idx] = blocks[idx] || {};
        }
        this._push();
        break;
      }
      case 'message_end': {
        const msg = evt.message;
        if (msg && msg.role === 'assistant') {
          const ui = normalizeMessage(msg);
          // 附上已收集的工具输出
          ui.toolCalls.forEach((tc) => {
            const out = this.state.toolOutputs.get(tc.id);
            if (out !== undefined) tc.output = out;
          });
          this.state.messages.push(ui);
          this.state.curAssistant = null;
        } else if (msg && msg.role === 'user') {
          // 权威 user 消息（可能带图片等），替换最后一个 user 消息
          const ui = normalizeMessage(msg);
          for (let i = this.state.messages.length - 1; i >= 0; i--) {
            if (this.state.messages[i].role === 'user') {
              this.state.messages[i] = ui;
              break;
            }
          }
        }
        this._push();
        break;
      }
      case 'tool_execution_start': {
        this.state.toolOutputs.set(evt.toolCallId, '');
        if (this.state.curAssistant) {
          const blocks = this.state.curAssistant.blocks;
          blocks.push({ type: 'toolcall', id: evt.toolCallId, name: evt.toolName, args: JSON.stringify(evt.args || {}) });
        }
        this._push();
        break;
      }
      case 'tool_execution_update': {
        const pr = evt.partialResult;
        const text = pr && Array.isArray(pr.content) ? pr.content.map((c) => c.text || '').join('\n') : '';
        if (text) this.state.toolOutputs.set(evt.toolCallId, text);
        this._push();
        break;
      }
      case 'tool_execution_end': {
        const res = evt.result;
        const text = res && Array.isArray(res.content) ? res.content.map((c) => c.text || '').join('\n') : '';
        this.state.toolOutputs.set(evt.toolCallId, text);
        // 同步到已完成的 assistant 消息里的卡片
        for (const m of this.state.messages) {
          for (const tc of m.toolCalls) {
            if (tc.id === evt.toolCallId) tc.output = text;
          }
        }
        this._push();
        break;
      }
      case 'extension_ui_request': {
        this._handleUiRequest(evt);
        break;
      }
      case 'stderr': {
        if (!this.state.statusText) {
          this.state.statusText = evt.text.trim().slice(0, 200);
        }
        break;
      }
      default:
        break;
    }
  }

  _handleUiRequest(req) {
    const respond = (payload) => this.client && this.client.sendUiResponse(req.id, payload);
    switch (req.method) {
      case 'confirm':
        vscode.window
          .showWarningMessage(req.message || req.title || '确认？', { modal: true }, 'Yes', 'No')
          .then((pick) => {
            if (pick === 'Yes') respond({ confirmed: true });
            else if (pick === 'No') respond({ confirmed: false });
            else respond({ cancelled: true });
          });
        break;
      case 'input':
        vscode.window
          .showInputBox({ title: req.title, prompt: req.title, placeHolder: req.placeholder })
          .then((v) => (v === undefined ? respond({ cancelled: true }) : respond({ value: v })));
        break;
      case 'select':
        vscode.window
          .showQuickPick(req.options || [], { title: req.title, placeHolder: req.title })
          .then((v) => (v === undefined ? respond({ cancelled: true }) : respond({ value: v })));
        break;
      case 'editor': {
        const opts = { title: req.title, value: req.prefill || '', valueSelection: [0, (req.prefill || '').length] };
        vscode.window.showInputBox(opts).then((v) => (v === undefined ? respond({ cancelled: true }) : respond({ value: v })));
        break;
      }
      case 'notify': {
        const fn =
          req.notifyType === 'warning'
            ? vscode.window.showWarningMessage
            : req.notifyType === 'error'
              ? vscode.window.showErrorMessage
              : vscode.window.showInformationMessage;
        fn(req.message || '');
        break;
      }
      default:
        break;
    }
  }

  send(text) {
    if (!this.client || !text || !text.trim()) return;
    this.state.messages.push({ role: 'user', text, thinking: '', toolCalls: [], done: true });
    this._push();
    const streamingBehavior = this.state.status === 'streaming' ? 'followUp' : undefined;
    this.client.send({ type: 'prompt', message: text, ...(streamingBehavior ? { streamingBehavior } : {}) }).catch((e) => {
      this.state.statusText = '发送失败: ' + e.message;
      this._push();
    });
  }

  abort() {
    if (this.client) this.client.send({ type: 'abort' }).catch(() => {});
  }

  setThinkingLevel(level) {
    if (!this.client || !level) return;
    this.client
      .send({ type: 'set_thinking_level', level })
      .then(() => {
        this.state.thinkingLevel = level;
        this._push();
      })
      .catch((e) => {
        this.state.statusText = '切换推理强度失败: ' + e.message;
        this._push();
      });
  }

  setWorkspace(name) {
    this.state.workspaceName = name || '';
    this._push();
  }

  setModel(ref) {
    if (!this.client || !ref) return;
    const slash = ref.indexOf('/');
    if (slash === -1) return;
    const provider = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    this.client
      .send({ type: 'set_model', provider, modelId })
      .then(() => this.client.send({ type: 'get_state' }))
      .then((res) => {
        if (res.success && res.data) {
          const m = res.data.model;
          this.state.model = m ? `${m.provider}/${m.id}` : '';
          this.state.thinkingLevel = res.data.thinkingLevel || '';
          this._push();
        }
      })
      .catch((e) => {
        this.state.statusText = '切换模型失败: ' + e.message;
        this._push();
      });
  }

  setDirectories(dirs) {
    this.state.directories = (dirs || []).filter(Boolean);
    this._push();
  }

  switchDirectory(fsPath) {
    if (!fsPath) return;
    // RPC 无切换目录命令：停止当前 pi 子进程，用新工作目录重启
    try {
      this.client && this.client.stop();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.state.messages = [];
    this.state.curAssistant = null;
    this.state.toolOutputs.clear();
    this.state.workspaceName = path.basename(fsPath) || fsPath;
    this.state.status = 'starting';
    this.state.statusText = '正在切换工作目录并重启 Pi…';
    this._push();
    this.start(fsPath);
    this.init();
  }

  async newSession() {
    if (!this.client) return;
    this.state.messages = [];
    this.state.curAssistant = null;
    this.state.toolOutputs.clear();
    this._push();
    try {
      await this.client.send({ type: 'new_session' });
    } catch (e) {
      this.state.statusText = '新会话失败: ' + e.message;
      this._push();
    }
  }

  init() {
    if (!this.client) return;
    this.client.send({ type: 'get_state' }).catch(() => {});
    this.client
      .send({ type: 'get_available_thinking_levels' })
      .then((res) => {
        if (res.success && Array.isArray(res.data.levels)) {
          this.state.availableLevels = res.data.levels;
          this._push();
        }
      })
      .catch(() => {});
    this.client
      .send({ type: 'get_available_models' })
      .then((res) => {
        if (res.success && Array.isArray(res.data.models)) {
          this.state.models = res.data.models.map((m) => {
            const ref = `${m.provider}/${m.id}`;
            // 参考 pi-web：用简短 label 显示（name 优先，否则用 id），value 保持完整 ref
            const label = m.name && m.name !== m.id ? m.name : m.id;
            return { ref, label };
          });
          this._push();
        }
      })
      .catch(() => {});
    this.client
      .send({ type: 'get_session_stats' })
      .then((res) => {
        if (res.success && res.data) {
          this.state.contextUsage = res.data.contextUsage || null;
          this._push();
        }
      })
      .catch(() => {});
    this.client
      .send({ type: 'get_messages' })
      .then((res) => {
        if (res.success && Array.isArray(res.data.messages)) {
          this.state.messages = res.data.messages
            .filter((m) => m && m.role !== 'toolResult')
            .map((m) => normalizeMessage(m));
          this.state.curAssistant = null;
          this._push();
        }
      })
      .catch(() => {});
  }

  dispose() {
    if (this.client) {
      this.client.stop();
      this.client = null;
    }
  }

  _push() {
    if (!this.webviewView) return;
    const s = this.state;
    const list = s.messages.slice();
    if (s.curAssistant) list.push(blockToUiMessage(s.curAssistant.blocks));
    this.webviewView.webview.postMessage({
      type: 'state',
      payload: {
        status: s.status,
        statusText: s.statusText,
        errorDetail: s.errorDetail,
        model: s.model,
        thinkingLevel: s.thinkingLevel,
        availableLevels: s.availableLevels,
        workspaceName: s.workspaceName,
        models: s.models,
        directories: s.directories,
        contextUsage: s.contextUsage,
        messages: list,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Webview Provider
// ---------------------------------------------------------------------------
const panel = new PiPanel();

class PiChatViewProvider {
  resolveWebviewView(webviewView) {
    panel.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message && message.command) {
        case 'send':
          panel.send(message.text);
          break;
        case 'abort':
          panel.abort();
          break;
        case 'newSession':
          panel.newSession();
          break;
        case 'setThinkingLevel':
          panel.setThinkingLevel(message.level);
          break;
        case 'setModel':
          panel.setModel(message.ref);
          break;
        case 'switchDirectory':
          panel.switchDirectory(message.path);
          break;
      }
    });

    // 面板每次可见时确保子进程已启动
    const cwd =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : os.homedir();
    const wsName =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].name
        : '';
    const dirs = [];
    if (vscode.workspace.workspaceFolders) {
      for (const f of vscode.workspace.workspaceFolders) dirs.push(f.uri.fsPath);
    }
    if (cwd && !dirs.includes(cwd)) dirs.push(cwd);
    panel.setWorkspace(wsName);
    panel.setDirectories(dirs);
    panel.start(cwd);
    panel.init();
  }
}

// ---------------------------------------------------------------------------
// 激活
// ---------------------------------------------------------------------------
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('pi-panel.focus', () =>
      // 默认在右侧辅助侧边栏打开 Pi 聊天面板；若容器命令不可用则切换辅助侧边栏
      vscode.commands
        .executeCommand('workbench.view.extension.pi-panel-aux')
        .then(undefined, () => vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar'))
    ),
    vscode.commands.registerCommand('pi-panel.newSession', () => panel.newSession()),
    vscode.commands.registerCommand('pi-panel.abort', () => panel.abort()),
    vscode.window.registerWebviewViewProvider('piChatView', new PiChatViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // 右侧辅助侧边栏（auxiliarybar）里同一个聊天面板
    vscode.window.registerWebviewViewProvider('piChatViewAux', new PiChatViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

function deactivate() {
  panel.dispose();
}

// ---------------------------------------------------------------------------
// Webview HTML（内联 CSS/JS）
// ---------------------------------------------------------------------------
function getHtml() {
  const nonce = 'piPanelNonce';
  return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --pad: 12px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  #header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); }
  #title { font-weight: 600; }
  #ctrlbar { display: flex; gap: 6px; align-items: center; }
  #ctrlbar select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 3px; font-size: 11px; padding: 1px 4px; max-width: 150px; }
  #ctx { margin-left: auto; display: none; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; cursor: default; }
  #ctx.warn { color: #d7ba7d; }
  #ctx.danger { color: #f14c4c; font-weight: 600; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: none; }
  #dot.idle { background: #4ec9b0; }
  #dot.streaming { background: #d7ba7d; animation: pulse 1s infinite; }
  #dot.error { background: #f14c4c; }
  #dot.starting { background: #888; animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  #model { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #status { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #messages { padding: 12px; overflow-y: auto; height: calc(100vh - 235px); display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 100%; }
  .msg.user { align-self: flex-end; }
  .bubble { padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
  .msg.user .bubble { background: var(--vscode-editor-selectionBackground, rgba(120,120,120,.2)); }
  .msg.assistant .bubble { background: transparent; }
  .thinking { margin: 4px 0; padding: 6px 8px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .toolcard { margin: 4px 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
  .toolcard summary { padding: 6px 8px; cursor: pointer; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .toolcard .toolbody { padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 11px; max-height: 300px; overflow: auto; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px; font-size: 12px; }
  #inputbar { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 12px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; gap: 6px; }
  #ta { width: 100%; min-height: 40px; max-height: 140px; resize: none; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; padding: 6px 8px; font-family: inherit; font-size: 13px; }
  #ta:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 6px; }
  button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <div id="header">
    <div id="dot" class="starting"></div>
    <span id="title">Pi</span>
    <span id="status"></span>
  </div>
  <div id="messages"></div>
  <div id="inputbar">
    <div id="ctrlbar">
      <select id="dirSel" title="切换工作目录"></select>
      <select id="modelSel" title="切换模型"></select>
      <select id="thinkSel" title="切换推理强度"></select>
      <span id="ctx" title="上下文使用情况"></span>
    </div>
    <textarea id="ta" placeholder="向 Pi 提问…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="row">
      <button id="btnSend">发送</button>
      <button id="btnStop" class="secondary">停止</button>
      <button id="btnNew" class="secondary">新会话</button>
      <span style="flex:1"></span>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const el = {
      dot: document.getElementById('dot'),
      status: document.getElementById('status'),
      dirSel: document.getElementById('dirSel'),
      modelSel: document.getElementById('modelSel'),
      thinkSel: document.getElementById('thinkSel'),
      ctx: document.getElementById('ctx'),
      messages: document.getElementById('messages'),
      ta: document.getElementById('ta'),
      send: document.getElementById('btnSend'),
      stop: document.getElementById('btnStop'),
      news: document.getElementById('btnNew'),
    };

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function shortArgs(args) {
      const s = String(args || '').trim();
      return s.length > 180 ? s.slice(0, 180) + '…' : s;
    }

    function basename(p) {
      const s = String(p || '');
      const parts = s.replace(/[\\/]+$/, '').split(/[\\/]/);
      return parts[parts.length - 1] || s;
    }
    function render(payload) {
      el.dot.className = payload.status || 'idle';
      el.status.textContent = payload.statusText || '';
      el.send.disabled = payload.status === 'streaming';
      el.stop.disabled = payload.status !== 'streaming';
      // 工作目录下拉（底部）
      const dirs = payload.directories || [];
      let dOpts = '';
      for (const d of dirs) {
        dOpts += '<option value="' + esc(d) + '">📁 ' + esc(basename(d)) + '</option>';
      }
      el.dirSel.innerHTML = dOpts;
      el.dirSel.disabled = dirs.length === 0;
      // 模型下拉（底部，显示简短 label 而非全称，参考 pi-web）
      const curModel = payload.model || '';
      const models = payload.models || [];
      let mOpts = '';
      for (const mo of models) {
        const ref = mo.ref || mo;
        const label = mo.label || basename(ref);
        mOpts += '<option value="' + esc(ref) + '"' + (ref === curModel ? ' selected' : '') + '>' + esc(label) + '</option>';
      }
      el.modelSel.innerHTML = mOpts;
      el.modelSel.disabled = models.length === 0;
      // 上下文使用情况（pi-web 风格纯文字：percent% / 格式化窗口，按使用率变色）
      const ctx = payload.contextUsage;
      if (ctx && ctx.contextWindow) {
        const pct = ctx.percent != null ? ctx.percent : (ctx.tokens != null ? (ctx.tokens / ctx.contextWindow) * 100 : null);
        const w = ctx.contextWindow;
        const wStr = w >= 1000000 ? (w / 1000000).toFixed(1) + 'M' : w >= 1000 ? Math.round(w / 1000) + 'k' : String(w);
        const pctStr = pct != null && isFinite(pct) ? pct.toFixed(1) + '%' : '?';
        el.ctx.textContent = '⏣ ' + pctStr + ' / ' + wStr;
        el.ctx.className = pct != null && pct > 90 ? 'danger' : pct != null && pct > 70 ? 'warn' : '';
        el.ctx.style.display = 'inline';
      } else {
        el.ctx.style.display = 'none';
      }
      // 推理强度下拉（底部）
      const cur = payload.thinkingLevel || '';
      const levels = payload.availableLevels || [];
      let opts = '';
      for (const l of levels) {
        opts += '<option value="' + esc(l) + '"' + (l === cur ? ' selected' : '') + '>' + esc(l) + '</option>';
      }
      el.thinkSel.innerHTML = opts;
      el.thinkSel.disabled = levels.length === 0;

      const msgs = payload.messages || [];
      let html = '';
      if (msgs.length === 0) {
        html = '<div class="empty">向 Pi 提问，开始编码会话。<br>支持 /model、/new、/resume 等命令。</div>';
      }
      for (const m of msgs) {
        if (m.role === 'user') {
          html += '<div class="msg user"><div class="bubble">' + esc(m.text) + '</div></div>';
          continue;
        }
        html += '<div class="msg assistant"><div class="bubble">';
        if (m.thinking) html += '<div class="thinking">' + esc(m.thinking) + '</div>';
        if (m.text) html += esc(m.text);
        for (const tc of m.toolCalls || []) {
          html += '<details class="toolcard" open><summary>🛠 ' + esc(tc.name || 'tool');
          if (tc.args) html += ' · ' + esc(shortArgs(tc.args));
          html += '</summary>';
          if (tc.output) html += '<div class="toolbody">' + esc(tc.output) + '</div>';
          html += '</details>';
        }
        html += '</div></div>';
      }
      if (payload.errorDetail) html += '<div class="error">' + esc(payload.errorDetail) + '</div>';
      el.messages.innerHTML = html;
      el.messages.scrollTop = el.messages.scrollHeight;
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg && msg.type === 'state') render(msg.payload);
    });

    function send() {
      const text = el.ta.value;
      if (!text.trim()) return;
      el.ta.value = '';
      vscode.postMessage({ command: 'send', text });
    }
    el.send.addEventListener('click', send);
    el.stop.addEventListener('click', () => vscode.postMessage({ command: 'abort' }));
    el.news.addEventListener('click', () => vscode.postMessage({ command: 'newSession' }));
    el.thinkSel.addEventListener('change', () => {
      const level = el.thinkSel.value;
      if (level) vscode.postMessage({ command: 'setThinkingLevel', level });
    });
    el.modelSel.addEventListener('change', () => {
      const ref = el.modelSel.value;
      if (ref) vscode.postMessage({ command: 'setModel', ref });
    });
    el.dirSel.addEventListener('change', () => {
      const p = el.dirSel.value;
      if (p) vscode.postMessage({ command: 'switchDirectory', path: p });
    });
    el.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    // 初始渲染占位
    render({ status: 'starting', statusText: '', model: '', messages: [] });
  </script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
