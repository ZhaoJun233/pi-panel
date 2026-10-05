const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const sourcePath = path.resolve(__dirname, '../extension.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function createIsolatedHarness() {
  const fakeChild = new EventEmitter();
  fakeChild.stdout = new EventEmitter();
  fakeChild.stderr = new EventEmitter();
  fakeChild.stdin = { write() {} };
  fakeChild.kill = () => true;

  const sandbox = {
    require: (name) => {
      if (name === 'vscode') {
        return {
          window: {
            showWarningMessage: async () => 'Yes',
            showInputBox: async () => 'test',
            showQuickPick: async () => 'option',
            showErrorMessage: () => {},
            showInformationMessage: () => {},
            registerWebviewViewProvider: () => {},
          },
          commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
          workspace: { workspaceFolders: [] },
        };
      }
      if (name === 'child_process') {
        return { spawn: () => fakeChild, execSync: () => {} };
      }
      return require(name);
    },
    module: { exports: {} },
    process,
    console,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    source + '\nmodule.exports.harness = { PiPanel, PiRpcClient, normalizeMessage, getHtml };',
    sandbox
  );
  return { ...sandbox.module.exports.harness, fakeChild };
}

console.log('=== Pi Panel 自动化回归与缺陷验证套件 ===');

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
}

async function runAllTests() {
  // 1. 验证用户输入字符串正文解析
  try {
    const { normalizeMessage } = createIsolatedHarness();
    const parsed = normalizeMessage({ role: 'user', content: 'test string' });
    const isFixed = parsed.text === 'test string';
    record('ISS-02: 支持 UserMessage.content 为纯字符串', isFixed, isFixed ? '解析成功' : '目前仅支持数组，纯字符串被丢弃');
  } catch (e) {
    record('ISS-02: 支持 UserMessage.content 为纯字符串', false, e.message);
  }

  // 2. 验证提问单次发送消息去重
  try {
    const { PiPanel } = createIsolatedHarness();
    const panel = new PiPanel();
    panel.client = { send: async () => ({ success: true }) };
    panel.send('hello');
    panel._onEvent({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    panel._onEvent({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
    const isFixed = panel.state.messages.length === 1;
    record('ISS-01: 提问消息去重与生命周期对齐', isFixed, isFixed ? '仅保留 1 条用户消息' : `当前存在重复消息: 数量=${panel.state.messages.length}`);
  } catch (e) {
    record('ISS-01: 提问消息去重与生命周期对齐', false, e.message);
  }

  // 3. 验证新会话失败保护
  try {
    const { PiPanel } = createIsolatedHarness();
    const panel = new PiPanel();
    panel.state.messages = [{ role: 'user', text: 'important history' }];
    panel.client = { send: async () => { throw new Error('Network busy'); } };
    await panel.newSession();
    const isFixed = panel.state.messages.length > 0;
    record('ISS-03: newSession 失败保留历史记录', isFixed, isFixed ? '历史完好' : '历史被提前清空');
  } catch (e) {
    record('ISS-03: newSession 失败保留历史记录', false, e.message);
  }

  // 4. 验证 UTF-8 跨 chunk 拼接
  try {
    const { PiRpcClient } = createIsolatedHarness();
    const events = [];
    const client = new PiRpcClient('.', (e) => events.push(e));
    const rawBytes = Buffer.from(JSON.stringify({ type: 'stderr', text: '测试中文' }) + '\n');
    const cut = rawBytes.indexOf(Buffer.from('中')) + 1;
    client._onData(rawBytes.subarray(0, cut));
    client._onData(rawBytes.subarray(cut));
    const isFixed = events.length > 0 && events[0].text === '测试中文';
    record('ISS-05: UTF-8 跨 Buffer chunk 拼接无乱码', isFixed, isFixed ? '正常还原中文字符' : '出现字节截断乱码');
  } catch (e) {
    record('ISS-05: UTF-8 跨 Buffer chunk 拼接无乱码', false, e.message);
  }

  // 5. 验证 Windows 路径 basename 解析
  try {
    const { getHtml } = createIsolatedHarness();
    const html = getHtml();
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    const uiSandbox = {
      document: { getElementById: () => ({ style: {}, addEventListener: () => {} }) },
      window: { addEventListener: () => {} },
      acquireVsCodeApi: () => ({ postMessage: () => {} }),
    };
    vm.runInNewContext(script + '\nglobalThis.testBasename = basename;', uiSandbox);
    const result = uiSandbox.testBasename('E:\\project\\demo');
    const isFixed = result === 'demo';
    record('ISS-09: Windows 路径 basename 提取', isFixed, isFixed ? '成功提取 basename' : `正则反斜杠未生效，返回: "${result}"`);
  } catch (e) {
    record('ISS-09: Windows 路径 basename 提取', false, e.message);
  }

  // 6. 验证切换目录异步事件竞争（Epoch 机制）
  try {
    const { PiPanel } = createIsolatedHarness();
    const panel = new PiPanel();
    panel.start('dir1');
    const oldClient = panel.client;
    panel.switchDirectory('dir2');
    // 模拟旧进程延迟触发 exit 事件
    oldClient.onEvent({ type: 'exit', code: 1, signal: null });
    const isFixed = panel.state.status !== 'error';
    record('ISS-04: 切换目录异步进程事件竞争隔离 (Epoch)', isFixed, isFixed ? '旧进程 exit 事件被有效拦截' : `状态被旧进程污染: ${panel.state.status}`);
  } catch (e) {
    record('ISS-04: 切换目录异步进程事件竞争隔离 (Epoch)', false, e.message);
  }

  // 7. 验证未决 RPC 请求在 stop/exit 时安全释放
  try {
    const { PiRpcClient } = createIsolatedHarness();
    const client = new PiRpcClient('.', () => {});
    client.child = { stdin: { write() {} }, kill() {} };
    let rejected = false;
    let rejectError = null;
    const p = client.send({ type: 'get_state' }).catch((err) => {
      rejected = true;
      rejectError = err;
    });
    const pendingCountBefore = client.pending.size;
    client.stop();
    await p;
    const isFixed = pendingCountBefore === 1 && client.pending.size === 0 && rejected;
    record('ISS-06: 进程退出/停止清理未决请求', isFixed, isFixed ? '未决 Map 已清空且 Promise 已拒绝' : '未决请求未清理');
  } catch (e) {
    record('ISS-06: 进程退出/停止清理未决请求', false, e.message);
  }

  // 8. 验证滚动保护机制 (用户向上翻阅时不强制拉底)
  try {
    const { getHtml } = createIsolatedHarness();
    const html = getHtml();
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    let scrollPos = 100;
    const mockMessages = {
      scrollHeight: 1000,
      get scrollTop() { return scrollPos; },
      set scrollTop(v) { scrollPos = v; },
      clientHeight: 300,
      innerHTML: '',
      children: [],
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: () => {},
      addEventListener: () => {},
    };
    const uiSandbox = {
      document: {
        getElementById: (id) => (id === 'messages' ? mockMessages : { style: {}, addEventListener: () => {} }),
        createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, innerHTML: '' }),
      },
      window: { addEventListener: () => {} },
      acquireVsCodeApi: () => ({ postMessage: () => {} }),
    };
    vm.runInNewContext(script + '\nglobalThis.render = render; globalThis.isNearBottom = isNearBottom;', uiSandbox);
    // 距离底部 1000 - 100 - 300 = 600 > 60，此时处于向上翻看状态
    const nearBottom = uiSandbox.isNearBottom();
    uiSandbox.render({ status: 'streaming', messages: [{ role: 'assistant', text: 'chunk' }] });
    const isFixed = !nearBottom && scrollPos === 100;
    record('ISS-07: 视口智能滚动保护', isFixed, isFixed ? '向上翻看时不强制跳底' : `滚动条被强制跳动到: ${scrollPos}`);
  } catch (e) {
    record('ISS-07: 视口智能滚动保护', false, e.message);
  }

  // 9. 验证工具历史数据关联与加载
  try {
    const { PiPanel } = createIsolatedHarness();
    const panel = new PiPanel();
    panel.client = {
      send: async (cmd) => {
        if (cmd.type === 'get_messages') {
          return {
            success: true,
            data: {
              messages: [
                { role: 'user', content: 'test tool' },
                { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } }] },
                { role: 'toolResult', toolUseId: 'call_1', content: [{ text: 'output line 1' }] },
              ],
            },
          };
        }
        return { success: true, data: {} };
      },
    };
    panel.init();
    await new Promise((r) => setTimeout(r, 20));
    const astMsg = panel.state.messages.find((m) => m.role === 'assistant');
    const toolCall = astMsg && astMsg.toolCalls[0];
    const isFixed = toolCall && toolCall.output === 'output line 1' && !panel.state.messages.some((m) => m.role === 'toolResult');
    record('ISS-08: 工具执行输出与历史回填关联', isFixed, isFixed ? '输出已回填至对应工具卡片' : '工具输出丢失或格式未对齐');
  } catch (e) {
    record('ISS-08: 工具执行输出与历史回填关联', false, e.message);
  }

  // 10. 验证发送按钮与键盘快捷键状态同步校验
  try {
    const { getHtml } = createIsolatedHarness();
    const html = getHtml();
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    let postedMessages = [];
    let keydownHandler = null;
    const mockTa = {
      value: 'ready message',
      addEventListener: (evt, handler) => {
        if (evt === 'keydown') keydownHandler = handler;
      },
    };
    const mockBtnSend = { disabled: false, addEventListener: () => {} };
    const mockBtnStop = { disabled: true, addEventListener: () => {} };
    const uiSandbox = {
      document: {
        getElementById: (id) => {
          if (id === 'ta') return mockTa;
          if (id === 'btnSend') return mockBtnSend;
          if (id === 'btnStop') return mockBtnStop;
          return { style: {}, addEventListener: () => {} };
        },
        createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, innerHTML: '' }),
      },
      window: { addEventListener: () => {} },
      acquireVsCodeApi: () => ({ postMessage: (msg) => postedMessages.push(msg) }),
    };
    vm.runInNewContext(script + '\nglobalThis.render = render;', uiSandbox);
    // starting 状态：按 Enter 不发送
    uiSandbox.render({ status: 'starting', messages: [] });
    keydownHandler({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    const blockedOnStarting = postedMessages.length === 0 && mockBtnSend.disabled === true;
    // idle 状态：按 Enter 成功发送
    uiSandbox.render({ status: 'idle', messages: [] });
    keydownHandler({ key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} });
    const sentOnIdle = postedMessages.length === 1 && mockBtnSend.disabled === false;
    const isFixed = blockedOnStarting && sentOnIdle;
    record('ISS-10: 键盘快捷键与状态一致性校验', isFixed, isFixed ? '非空闲状态拦截发送，空闲状态允许' : '快捷键与状态脱节');
  } catch (e) {
    record('ISS-10: 键盘快捷键与状态一致性校验', false, e.message);
  }

  // 11. 验证多 Webview 视图同步广播机制
  try {
    const { PiPanel } = createIsolatedHarness();
    const panel = new PiPanel();
    const v1Msgs = [];
    const v2Msgs = [];
    const view1 = { webview: { postMessage: (m) => v1Msgs.push(m) }, onDidDispose: () => {} };
    const view2 = { webview: { postMessage: (m) => v2Msgs.push(m) }, onDidDispose: () => {} };
    panel.addWebview(view1);
    panel.addWebview(view2);
    panel.state.status = 'idle';
    panel._push();
    const isFixed = panel.webviews.size === 2 && v1Msgs.length > 0 && v2Msgs.length > 0;
    record('ISS-11: 多 Webview 视图状态广播同步', isFixed, isFixed ? '主/辅侧边栏视图均收到同步状态' : '视图未多路广播');
  } catch (e) {
    record('ISS-11: 多 Webview 视图状态广播同步', false, e.message);
  }

  const allPassed = results.every((r) => r.pass);
  console.log(`\n测试汇总: ${results.filter((r) => r.pass).length}/${results.length} 通过`);
  if (!allPassed) {
    process.exit(1);
  }
}

runAllTests();
