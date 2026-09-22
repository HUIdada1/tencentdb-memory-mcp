## 改了什么

<!-- 一到三句。写"结果"，不要复述 diff。 -->

## 为什么

<!-- 解决什么问题？关联 Issue：Closes #123 -->

## 怎么验证的

- [ ] `npm run test:ci` 全绿（贴关键输出更佳）
- [ ] 新增/修改的行为已补对应测试（说明加到哪个套件）
- [ ] 面向用户的变更已写入 `CHANGELOG.md` 的 `[Unreleased]`
- [ ] 版本号若变动，已四处同步（root / pet / daemon `APP_VER` / mcp `SERVER_VER`）

## 自查清单

- [ ] 没有引入作者机器路径或私有项目名（`hygiene` job 会拦）
- [ ] 没有给根 `package.json` 加运行时依赖
- [ ] 若改了 `daemon/tdai-daemon.js`：仍保持**单文件自包含**（不 `require` 本项目其它模块），
      且与 `core/clients.js` 共享的常量已在 `test/clients-consistency.test.js` 里有断言
- [ ] 若改了 Agent 接入：`检测面` 与 `写入面` 同源（没有"写一套、查一套"的字面量）
- [ ] 若改了前端：CSS 圆角用了变量、HTML id 全文档唯一、新 `data-act` 有处理分支

## 补充说明

<!-- 截图 / 兼容性影响 / 需要 reviewer 特别注意的地方 -->
