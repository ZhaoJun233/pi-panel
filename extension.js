// Pi Panel — 在 VS Code 侧边栏以聊天面板使用 Pi coding agent。
// 通过 `pi --mode rpc` 的 JSONL 协议与 Pi 子进程通信，无第三方依赖。
// 协议参考：@earendil-works/pi-coding-agent/docs/rpc.md

const vscode = require('vscode');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
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
    this.decoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
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
    child.stderr.on('data', (d) => {
      const text = this.stderrDecoder.write(d);
      if (text) {
        this.onEvent({ type: 'stderr', text });
      }
    });
    child.on('exit', (code, signal) => {
      this._rejectAllPending(new Error(`Pi 进程已退出 (code=${code})`));
      this.onEvent({ type: 'exit', code, signal });
    });
    child.on('error', (err) => {
      this._rejectAllPending(err);
      this.onEvent({
        type: 'spawn_error',
        message: err.message,
        command: cmd,
        hint: err.code === 'ENOENT' ? `找不到命令 "${cmd}"，请确认已安装 pi 并在 PATH 中。` : undefined,
      });
    });
  }

  _rejectAllPending(err) {
    const error = err instanceof Error ? err : new Error(String(err || 'Pi 进程异常终止'));
    for (const [id, entry] of this.pending.entries()) {
      try {
        entry.reject(error);
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
  }

  _onData(d) {
    this.buffer += this.decoder.write(d);
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

  send(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!cmd.id) cmd.id = 'r' + ++this.seq;
      const cmdId = cmd.id;
      let timer = null;
      // 默认 30s 超时；prompt 交互耗时可能很长，不设置短超时
      const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : (cmd.type === 'prompt' ? 0 : 30000);
      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(cmdId)) {
            this.pending.delete(cmdId);
            reject(new Error(`RPC 请求超时: ${cmd.type || cmd.command || 'unknown'} (${effectiveTimeout}ms)`));
          }
        }, effectiveTimeout);
      }

      this.pending.set(cmdId, {
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });

      const line = JSON.stringify(cmd) + '\n';
      try {
        if (!this.child || !this.child.stdin || this.child.killed) {
          throw new Error('Pi 进程未运行或已终止');
        }
        this.child.stdin.write(line);
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(cmdId);
        reject(e);
      }
    });
  }

  sendUiResponse(id, payload) {
    try {
      if (this.child && this.child.stdin) {
        this.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id, ...payload }) + '\n');
      }
    } catch {
      /* ignore */
    }
  }

  stop() {
    this._rejectAllPending(new Error('RPC 客户端主动停止'));
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      if (process.platform === 'win32' && child.pid) {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          child.kill();
        }
      } else {
        child.kill();
      }
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// UI 状态与消息归一化
// ---------------------------------------------------------------------------
function normalizeMessage(msg) {
  if (!msg) return { role: 'assistant', text: '', thinking: '', toolCalls: [], done: true };
  const ui = {
    id: msg.id || '',
    role: msg.role,
    text: '',
    thinking: '',
    toolCalls: [],
    errorMessage: msg.errorMessage || '',
    stopReason: msg.stopReason || '',
    done: true,
  };

  if (typeof msg.content === 'string') {
    ui.text = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!block) continue;
      if (typeof block === 'string') {
        ui.text += block;
      } else if (typeof block === 'object') {
        if (block.type === 'text') {
          ui.text += block.text || '';
        } else if (block.type === 'thinking') {
          ui.thinking += block.thinking || '';
        } else if (block.type === 'toolCall') {
          ui.toolCalls.push({
            id: block.id || '',
            name: block.name || block.toolName || 'tool',
            args: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? block.input ?? {}),
            output: '',
          });
        } else if (block.type === 'toolResult') {
          const text = (Array.isArray(block.content) ? block.content : (typeof block.content === 'string' ? [{ text: block.content }] : []))
            .map((c) => (c && c.text) || '')
            .join('\n');
          ui.toolCalls.push({ id: block.toolCallId || block.toolUseId || '', name: 'toolResult', args: '', output: text });
        }
      }
    }
  } else if (typeof msg.text === 'string') {
    ui.text = msg.text;
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
      ui.toolCalls.push({ id: b.id || '', name: b.name || 'tool', args: b.args || '', output: b.output || '' });
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
    this.currentEpoch = 0;
    this.webviews = new Set();
    this.state = {
      status: 'idle', // starting | idle | streaming | error
      statusText: '',
      errorDetail: '',
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

  get webviewView() {
    return this.webviews.values().next().value || null;
  }

  set webviewView(v) {
    if (v) this.addWebview(v);
  }

  addWebview(view) {
    this.webviews.add(view);
    if (typeof view.onDidDispose === 'function') {
      view.onDidDispose(() => {
        this.webviews.delete(view);
      });
    }
    this._push();
  }

  start(cwd, expectedEpoch) {
    if (this.client) return;
    const epoch = expectedEpoch !== undefined ? expectedEpoch : ++this.currentEpoch;
    this.currentEpoch = epoch;
    this.state.status = 'starting';
    this.state.statusText = '正在启动 Pi…';
    this._push();
    this.client = new PiRpcClient(cwd, (evt) => {
      if (this.currentEpoch !== epoch) return;
      this._onEvent(evt);
    });
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
          if (this.state.status === 'starting') {
            this.state.status = 'idle';
            this.state.statusText = '';
          }
          this._push();
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
        // 自动拉取最新的 get_session_stats 刷新 Context 状态
        if (this.client) {
          this.client
            .send({ type: 'get_session_stats' })
            .then((res) => {
              if (res.success && res.data) {
                this.state.contextUsage = res.data.contextUsage || null;
                this._push();
              }
            })
            .catch(() => {});
        }
        break;
      case 'message_start': {
        const role = evt.message && evt.message.role;
        if (role === 'user') {
          const ui = normalizeMessage(evt.message);
          // 查找是否已有匹配或待确认的最后一个 user 消息（例如 send 乐观插入的）
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'user' && (!lastMsg.id || lastMsg.id === ui.id || !ui.id || lastMsg.text === ui.text || lastMsg.pending)) {
            Object.assign(lastMsg, ui, { pending: false });
          } else {
            this.state.messages.push(ui);
          }
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
          blocks[idx] = blocks[idx] || { type: 'toolcall', id: '', name: '', args: '', output: '' };
        } else if (ev.type === 'toolcall_delta') {
          const b = (blocks[idx] = blocks[idx] || { type: 'toolcall', id: '', name: '', args: '', output: '' });
          b.args += ev.delta || '';
        } else if (ev.type === 'toolcall_end') {
          const tc = ev.toolCall || {};
          blocks[idx] = {
            type: 'toolcall',
            id: tc.id || '',
            name: tc.name || tc.toolName || 'tool',
            args: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? tc.input ?? {}),
            output: this.state.toolOutputs.get(tc.id) || '',
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
          // 权威 user 消息（可能带图片等），替换或完善对应的 user 消息
          const ui = normalizeMessage(msg);
          let found = false;
          for (let i = this.state.messages.length - 1; i >= 0; i--) {
            const m = this.state.messages[i];
            if (m.role === 'user') {
              if (!m.id || m.id === ui.id || m.text === ui.text || m.pending) {
                this.state.messages[i] = Object.assign(m, ui, { done: true, pending: false });
                found = true;
                break;
              }
            }
          }
          if (!found) {
            this.state.messages.push(ui);
          }
        }
        this._push();
        break;
      }
      case 'tool_execution_start': {
        this.state.toolOutputs.set(evt.toolCallId, '');
        if (this.state.curAssistant) {
          const blocks = this.state.curAssistant.blocks;
          let exists = false;
          for (const b of blocks) {
            if (b.type === 'toolcall' && b.id === evt.toolCallId) {
              exists = true;
              break;
            }
          }
          if (!exists) {
            blocks.push({
              type: 'toolcall',
              id: evt.toolCallId,
              name: evt.toolName,
              args: typeof evt.args === 'string' ? evt.args : JSON.stringify(evt.args || {}),
              output: '',
            });
          }
        }
        this._push();
        break;
      }
      case 'tool_execution_update': {
        const pr = evt.partialResult;
        let text = '';
        if (typeof pr === 'string') {
          text = pr;
        } else if (pr && Array.isArray(pr.content)) {
          text = pr.content.map((c) => c.text || '').join('\n');
        } else if (pr && typeof pr.text === 'string') {
          text = pr.text;
        }
        if (text) {
          this.state.toolOutputs.set(evt.toolCallId, text);
          if (this.state.curAssistant) {
            for (const b of this.state.curAssistant.blocks) {
              if (b.type === 'toolcall' && b.id === evt.toolCallId) {
                b.output = text;
              }
            }
          }
          for (const m of this.state.messages) {
            for (const tc of m.toolCalls) {
              if (tc.id === evt.toolCallId) tc.output = text;
            }
          }
        }
        this._push();
        break;
      }
      case 'tool_execution_end': {
        const res = evt.result;
        let text = '';
        if (typeof res === 'string') {
          text = res;
        } else if (res && Array.isArray(res.content)) {
          text = res.content.map((c) => c.text || '').join('\n');
        } else if (res && typeof res.text === 'string') {
          text = res.text;
        }
        this.state.toolOutputs.set(evt.toolCallId, text);
        if (this.state.curAssistant) {
          for (const b of this.state.curAssistant.blocks) {
            if (b.type === 'toolcall' && b.id === evt.toolCallId) {
              b.output = text;
            }
          }
        }
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
    this.state.messages.push({
      id: 'pending_' + Date.now(),
      role: 'user',
      text,
      thinking: '',
      toolCalls: [],
      done: true,
      pending: true,
    });
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
    const epoch = ++this.currentEpoch;
    // RPC 无切换目录命令：停止当前 pi 子进程，用新工作目录重启
    try {
      if (this.client) this.client.stop();
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
    this.start(fsPath, epoch);
    this.init();
  }

  async newSession() {
    if (!this.client) return;
    try {
      const res = await this.client.send({ type: 'new_session' });
      if (res && res.data && res.data.cancelled) {
        return;
      }
      this.state.messages = [];
      this.state.curAssistant = null;
      this.state.toolOutputs.clear();
      this.state.statusText = '';
      this._push();
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
          const rawMsgs = res.data.messages;
          const toolResultMap = new Map();
          for (const m of rawMsgs) {
            if (!m) continue;
            if (m.role === 'toolResult') {
              const toolCallId = m.toolCallId || m.toolUseId || '';
              const text = (Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ text: m.content }] : []))
                .map((c) => (c && c.text) || '')
                .join('\n');
              if (toolCallId) {
                toolResultMap.set(toolCallId, text);
                this.state.toolOutputs.set(toolCallId, text);
              }
            }
          }
          const uiMsgs = [];
          for (const m of rawMsgs) {
            if (!m || m.role === 'toolResult') continue;
            const ui = normalizeMessage(m);
            if (ui.role === 'assistant' && Array.isArray(ui.toolCalls)) {
              for (const tc of ui.toolCalls) {
                if (!tc.output && toolResultMap.has(tc.id)) {
                  tc.output = toolResultMap.get(tc.id);
                }
              }
            }
            uiMsgs.push(ui);
          }
          this.state.messages = uiMsgs;
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
    if (this.webviews.size === 0) return;
    const s = this.state;
    const list = s.messages.slice();
    if (s.curAssistant) list.push(blockToUiMessage(s.curAssistant.blocks));
    const payload = {
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
    };
    for (const view of this.webviews) {
      try {
        view.webview.postMessage(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Webview Provider
// ---------------------------------------------------------------------------
const panel = new PiPanel();

class PiChatViewProvider {
  resolveWebviewView(webviewView) {
    panel.addWebview(webviewView);
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
  .textbody { white-space: pre-wrap; word-break: break-word; }
  .codeblock { margin: 6px 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
  .codehead { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .codehead button { font-size: 10px; padding: 1px 6px; background: transparent; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; }
  .codehead button:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
  .codeblock pre { margin: 0; padding: 8px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .codeblock code { font-family: inherit; }
  code.inline { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.15)); padding: 2px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .errmsg { margin: 4px 0; padding: 6px 8px; border-left: 3px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); font-size: 12px; background: rgba(241, 76, 76, 0.1); border-radius: 0 4px 4px 0; }
  .toolcard { margin: 4px 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
  .toolcard summary { padding: 6px 8px; cursor: pointer; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .toolcard .toolbody { padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 11px; max-height: 300px; overflow: auto; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
  .empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px; font-size: 12px; line-height: 1.6; }
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

    let currentStatus = 'starting';

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function shortArgs(args) {
      const s = String(args || '').trim();
      return s.length > 180 ? s.slice(0, 180) + '…' : s;
    }

    function basename(p) {
      const s = String(p || '');
      const parts = s.replace(/[\\\\/]+$/, '').split(/[\\\\/]/);
      return parts[parts.length - 1] || s;
    }

    function formatMarkdown(raw) {
      if (!raw) return '';
      const codeBlocks = [];
      let text = raw.replace(/\`\`\`([a-zA-Z0-9_-]*)\\r?\\n([\\s\\S]*?)\`\`\`/g, function(_, lang, code) {
        const idx = codeBlocks.length;
        const langLabel = lang ? esc(lang) : 'code';
        const codeEscaped = esc(code.replace(/\\r?\\n$/, ''));
        codeBlocks.push(
          '<div class="codeblock"><div class="codehead"><span>' +
            langLabel +
            '</span><button class="copybtn" type="button">复制</button></div><pre><code>' +
            codeEscaped +
            '</code></pre></div>'
        );
        return '%%CODEBLOCK_' + idx + '%%';
      });
      text = esc(text);
      text = text.replace(/\`([^\`\\n]+)\`/g, '<code class="inline">$1</code>');
      text = text.replace(/\\*\\*([^\\*\\n]+)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(/%%CODEBLOCK_(\\d+)%%/g, function(_, idx) {
        return codeBlocks[Number(idx)] || '';
      });
      return text;
    }

    function isNearBottom() {
      const threshold = 60;
      return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight <= threshold;
    }

    function renderMessages(msgs, errorDetail) {
      if (msgs.length === 0 && !errorDetail) {
        el.messages.innerHTML = '<div class="empty">向 Pi 提问，开始编码会话。<br>可在下方切换工作目录、模型与推理强度。<br>快捷键：Enter 发送，Shift+Enter 换行。</div>';
        return;
      }

      const emptyEl = el.messages.querySelector('.empty');
      if (emptyEl) emptyEl.remove();

      const wasNearBottom = isNearBottom();

      const currentMsgEls = Array.from(el.messages.querySelectorAll('.msg'));
      if (currentMsgEls.length > msgs.length) {
        for (let i = msgs.length; i < currentMsgEls.length; i++) {
          currentMsgEls[i].remove();
        }
        currentMsgEls.length = msgs.length;
      }

      msgs.forEach((m, idx) => {
        let msgEl = currentMsgEls[idx];
        const isUser = m.role === 'user';
        const expectedClass = 'msg ' + (isUser ? 'user' : 'assistant');
        if (!msgEl) {
          msgEl = document.createElement('div');
          msgEl.className = expectedClass;
          msgEl.setAttribute('data-idx', String(idx));
          el.messages.appendChild(msgEl);
        } else if (msgEl.className !== expectedClass) {
          msgEl.className = expectedClass;
        }

        let inner = '';
        if (isUser) {
          inner = '<div class="bubble">' + esc(m.text) + '</div>';
        } else {
          inner = '<div class="bubble">';
          if (m.thinking) inner += '<div class="thinking">' + esc(m.thinking) + '</div>';
          if (m.text) inner += '<div class="textbody">' + formatMarkdown(m.text) + '</div>';
          for (const tc of m.toolCalls || []) {
            inner += '<details class="toolcard" open><summary>🛠 ' + esc(tc.name || 'tool');
            if (tc.args) inner += ' · ' + esc(shortArgs(tc.args));
            inner += '</summary>';
            if (tc.output) inner += '<div class="toolbody">' + esc(tc.output) + '</div>';
            inner += '</details>';
          }
          if (m.errorMessage) inner += '<div class="errmsg">⚠️ ' + esc(m.errorMessage) + '</div>';
          inner += '</div>';
        }

        if (msgEl.innerHTML !== inner) {
          msgEl.innerHTML = inner;
        }
      });

      let errEl = el.messages.querySelector('.error');
      if (errorDetail) {
        if (!errEl) {
          errEl = document.createElement('div');
          errEl.className = 'error';
          el.messages.appendChild(errEl);
        }
        if (errEl.textContent !== errorDetail) {
          errEl.textContent = errorDetail;
        }
      } else if (errEl) {
        errEl.remove();
      }

      if (wasNearBottom) {
        el.messages.scrollTop = el.messages.scrollHeight;
      }
    }

    function render(payload) {
      currentStatus = payload.status || 'idle';
      el.dot.className = currentStatus;
      el.status.textContent = payload.statusText || '';
      const canSend = currentStatus === 'idle';
      el.send.disabled = !canSend;
      el.stop.disabled = currentStatus !== 'streaming';

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

      renderMessages(payload.messages || [], payload.errorDetail);
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg && msg.type === 'state') render(msg.payload);
    });

    el.messages.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest('.copybtn');
      if (!btn) return;
      const block = btn.closest('.codeblock');
      const codeEl = block ? block.querySelector('pre code') : null;
      if (!codeEl) return;
      const text = codeEl.innerText || codeEl.textContent || '';
      const onCopied = () => {
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(onCopied).catch(fallback);
      } else {
        fallback();
      }
      function fallback() {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          onCopied();
        } catch (_) {}
        document.body.removeChild(ta);
      }
    });

    function send() {
      if (currentStatus !== 'idle') return;
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
        if (currentStatus === 'idle') {
          send();
        }
      }
    });

    // 初始渲染占位
    render({ status: 'starting', statusText: '', model: '', messages: [] });
  </script>
</body>
</html>`;
}

module.exports = { activate, deactivate, PiPanel, PiRpcClient, normalizeMessage, getHtml };
