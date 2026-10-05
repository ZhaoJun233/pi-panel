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
        return { spawn: () => fakeChild };
      }
      return require(name);
    },
    module: { exports: {} },
    process,
    console,
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
  panel.newSession().then(() => {
    const isFixed = panel.state.messages.length > 0;
    record('ISS-03: newSession 失败保留历史记录', isFixed, isFixed ? '历史完好' : '历史被提前清空');
  });
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
