// 会话来源回归：覆盖 Codex rollout、归档目录和通用 JSONL 适配。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdai-session-sources-'));
process.env.USERPROFILE = root;
process.env.HOME = root;
const codexLive = path.join(root, '.codex', 'sessions', '2026', '09', '22');
const codexArchive = path.join(root, '.codex', 'archived_sessions');
const piDir = path.join(root, '.pi', 'agent', 'sessions', 'project');
const workbuddyDir = path.join(root, '.workbuddy-ai', 'logs', 'sdk', 'conversations', 'project');
const workbuddyNoiseDir = path.join(root, '.workbuddy-ai', 'logs');
for (const dir of [codexLive, codexArchive, piDir, workbuddyDir, workbuddyNoiseDir]) fs.mkdirSync(dir, { recursive: true });

const codexId = '019e8c73-ba4e-7ab3-861d-f4c17a112201';
fs.writeFileSync(path.join(root, '.codex', 'session_index.jsonl'), JSON.stringify({ id: codexId, thread_name: 'Codex 标题' }) + '\n');
const codexLine = (role, text) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
fs.writeFileSync(path.join(codexLive, `rollout-2026-09-22T23-00-00-${codexId}.jsonl`), [codexLine('user', 'Codex 用户消息'), codexLine('assistant', 'Codex 助手消息')].join('\n') + '\n');
fs.writeFileSync(path.join(codexArchive, 'rollout-2026-08-01T10-00-00-019e8ca6-37e7-7ef2-8997-f499332f8ba2.jsonl'), codexLine('user', '归档消息') + '\n');
fs.writeFileSync(path.join(piDir, 'session.jsonl'), JSON.stringify({ message: { role: 'user', content: 'Pi 消息' } }) + '\n');
const workbuddyLine = '2026-09-22T23:00:00.000Z method:requests:result ' + JSON.stringify({ state: [{ userContent: [{ type: 'text', text: 'WorkBuddy 用户消息' }], assistantContent: [{ type: 'text', text: 'WorkBuddy 助手消息' }] }] });
fs.writeFileSync(path.join(workbuddyDir, 'conversation.log'), workbuddyLine + '\n');
fs.writeFileSync(path.join(workbuddyNoiseDir, 'daemon.log'), '2026-09-22T23:00:00.000Z daemon started\n');

const sessions = require('../pet/src/sessions.js');
const daemon = require('../daemon/tdai-daemon.js');
assert.deepStrictEqual(sessions.parseCodexLine(JSON.parse(codexLine('assistant', '回答'))), { role: 'assistant', content: '回答' });
assert.strictEqual(sessions.parseCodexLine(JSON.parse(codexLine('developer', '系统'))), null);
assert.strictEqual(sessions.parseGenericLine({ message: { role: 'user', content: '通用消息' } }).content, '通用消息');
assert.strictEqual(sessions.parseGenericLine({ messages: [{ role: 'assistant', content: '批量消息' }] })[0].content, '批量消息');
assert.deepStrictEqual(sessions.parseWorkBuddyLine(workbuddyLine), [
  { role: 'user', content: 'WorkBuddy 用户消息' },
  { role: 'assistant', content: 'WorkBuddy 助手消息' },
]);
assert.ok(sessions.codexFiles().length >= 2, '应发现 Codex 实时与归档会话');
const scanned = sessions.scanSessions({ limit: 0 });
assert.ok(scanned.sessions.some((x) => x.source === 'codex' && x.label === 'Codex 标题'), '实时扫描应显示 Codex 标题');
assert.ok(scanned.sessions.some((x) => x.source === 'pi'), '通用 Agent 会话应可扫描');
assert.ok(scanned.sessions.some((x) => x.source === 'workbuddy'), 'WorkBuddy 对话日志应可扫描');
assert.ok(!scanned.sessions.some((x) => x.file.endsWith('daemon.log')), 'WorkBuddy daemon 日志不得伪装成会话');
assert.ok(daemon.SOURCES.codex && daemon.SOURCES.opencode && daemon.SOURCES.pi, '守护进程来源清单应完整');
assert.deepStrictEqual(daemon.parseCodexLine(codexLine('user', '上传消息')), [{ role: 'user', content: '上传消息' }]);
assert.deepStrictEqual(daemon.parseWorkBuddyLine(workbuddyLine), [
  { role: 'user', content: 'WorkBuddy 用户消息' },
  { role: 'assistant', content: 'WorkBuddy 助手消息' },
]);
const inventory = daemon.agentInventory({});
assert.ok(inventory.items.some((x) => x.source === 'workbuddy'), '上传清单应包含 WorkBuddy 对话');
assert.ok(!inventory.items.some((x) => x.dir.endsWith('logs')), '上传清单不得包含 WorkBuddy 普通日志目录');
console.log('session-sources.test.js：通过');
fs.rmSync(root, { recursive: true, force: true });
