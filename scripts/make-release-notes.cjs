#!/usr/bin/env node
// make-release-notes.cjs —— 从 CHANGELOG.md 提取指定版本的段落，生成 build/release-notes.md
//
// 为什么需要它：
//   electron-builder 的 getReleaseInfo() 会在 buildResources（build/）下查找
//   release-notes.md，读到后写进 latest.yml 的 releaseNotes 字段。
//   electron-updater 的 update-available 事件把它作为 info.releaseNotes 抛出，
//   应用设置页「更新中心」的 #up-notes 就靠它渲染更新说明。
//   此前该文件不存在 → latest.yml 无 releaseNotes → 更新说明永远是空的。
//
// 用法：
//   node scripts/make-release-notes.cjs [版本号]
//   版本号缺省取 pet/package.json 的 version。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const PET_PKG = path.join(ROOT, 'pet', 'package.json');
const OUT_DIR = path.join(ROOT, 'build');
const OUT_FILE = path.join(OUT_DIR, 'release-notes.md');

function resolveVersion(argv) {
  const given = (argv[2] || '').trim().replace(/^v/, '');
  if (given) return given;
  try {
    return JSON.parse(fs.readFileSync(PET_PKG, 'utf8')).version;
  } catch (e) {
    throw new Error('无法读取 pet/package.json 的版本号：' + e.message);
  }
}

// 从 CHANGELOG 里抠出 `## [x.y.z] - 日期` 到下一个 `## [` 之间的正文。
function extractSection(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 标题可能写作 [1.2.3] 或 1.2.3，日期后缀可有可无
  const re = new RegExp(
    '^##\\s+\\[?' + esc + '\\]?(?:\\s*[-—–]\\s*[^\\n]*)?\\s*\\n([\\s\\S]*?)(?=^##\\s+\\[|\\s*$(?![\\s\\S]))',
    'm'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function main() {
  const version = resolveVersion(process.argv);
  if (!fs.existsSync(CHANGELOG)) {
    console.error('✗ 找不到 CHANGELOG.md：' + CHANGELOG);
    process.exit(1);
  }
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const body = extractSection(text, version);

  // 没有该版本的段落时**不写空文件**：留一个空 releaseNotes 会让更新中心
  // 显示一块空白区域，不如让 latest.yml 里干脆没有这个字段。
  if (!body) {
    console.error(`✗ CHANGELOG.md 中找不到版本 ${version} 的段落，未生成 release-notes.md`);
    console.error('  请先为该版本补上 `## [' + version + '] - YYYY-MM-DD` 小节。');
    process.exit(1);
  }

  // 表格分隔行 `| --- | --- |` 在纯文本渲染里是噪音，去掉首尾管道并压平
  const cleaned = body
    .replace(/^\|\s*[-: |]+\|\s*$/gm, '')
    .replace(/^\|(.+)\|$/gm, (_, inner) =>
      inner.split('|').map((c) => c.trim()).filter(Boolean).join(' · '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, cleaned + '\n', 'utf8');

  const bytes = Buffer.byteLength(cleaned, 'utf8');
  console.log(`✓ 已生成 build/release-notes.md（版本 ${version}，${bytes} 字节）`);
  console.log('  electron-builder 会把它写入 latest.yml 的 releaseNotes 字段，');
  console.log('  应用「更新中心」据此显示更新说明。');
}

main();
