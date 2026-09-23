### Added
- **应用「更新中心」从此有更新说明**。此前 latest.yml 里没有 releaseNotes 字段，更新弹窗
  的说明区永远是空白。现在 CI 发版时由 `scripts/make-release-notes.cjs` 从 CHANGELOG.md
  提取当前版本段落生成 `build/release-notes.md`，electron-builder 写进 latest.yml 的
  releaseNotes 字段；同一次构建再用 `gh release edit` 把同一份说明回填到 GitHub Release
  页面 body（electron-publish 的 createRelease 只写 tag 名不含 body，网页端此前也是空的）。
- 便携版检查更新改为直接解析 latest.yml 的 releaseNotes（块标量 `|` / `>` 与单行两种
  YAML 形式都认），与安装版 electron-updater 拿到的 info.releaseNotes 同源。
- 新增 `test/release-notes.test.js`（`npm run test:release-notes`），并纳入 test:ci /
  test:all：覆盖版本段落提取、表格压平、段落缺失时报错不写空文件、两种 YAML 形式的
  releaseNotes 解析。
