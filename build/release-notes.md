### Fixed
- **修复 ZCode 客户端永远显示「注入未完全生效」**。pet 的接入/状态接口（agents-status /
  agents-register / agents-toggle）此前从不传 `workspaceRoot`，而 ZCode 的
  `UserPromptSubmit` hook 是**工作区级**（`<项目>/.zcode/config.json`），导致：
  hook 永远写不进任何项目（接入结果里静默记为"未指定工作区"）、状态页永远显示
  "hook 为工作区级（选项目后可见状态）"并保守判成"注入未完全生效"，用户无论怎么
  重开开关、重启客户端都不会变。现在 pet 统一取**最近活跃的 ZCode 会话工作区**
  （sqlite 权威源的 session.directory，只认 fromDb 行；实时文件来源的 file 是
  transcript 路径不能当工作区）——接入即自动把 hook 写进用户最近用 ZCode 的项目，
  状态页也能判出真值"hook 已注入"。
- **修复 hook 包装脚本在中文环境下静默失败**。`tdai-hook.cmd` 以 UTF-8 落盘，而
  exe 文件名本身含中文（`TD记忆守护.exe`），cmd.exe 默认按系统代码页（GBK）逐行
  解析批处理，中文路径被读成乱码，报「不是内部或外部命令」——hook 即使写入配置，
  执行也是静默失败、无任何报错面。现在脚本在含中文的行之前插入 `chcp 65001 >nul`
  （cmd 逐行解析，chcp 之后的行才按 UTF-8 读；文件保持无 BOM，BOM 会让 `@echo off`
  报错），并新增测试断言守住 chcp 必须在中文路径之前。已实测：修复前复现乱码报错，
  修复后 hook 正常输出记忆注入块（退出码 0）。

### Changed
- 开源适配：`.gitignore` 忽略 `.zcode/`（工作区级 hook 配置是本机文件，不应入库）。
