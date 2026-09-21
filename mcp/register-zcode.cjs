// register-zcode.cjs — 把 tdai MCP 注册到 ZCode CLI 的 ~/.zcode/cli/config.json
// 幂等：已存在同名条目则覆盖。跑前自动备份。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = CFG + '.bak.' + stamp;
fs.copyFileSync(CFG, bak);

const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
c.mcp = c.mcp || {};
c.mcp.servers = c.mcp.servers || {};
c.mcp.servers.tdai = {
  type: 'stdio',
  command: 'E:\\nvm\\v22.22.0\\node.exe',
  args: ['E:\\idea work\\腾讯记忆链接\\mcp\\tdai-mcp.js'],
};
fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
console.log('备份:', bak);
console.log('已注册 tdai →', JSON.stringify(c.mcp.servers.tdai));
