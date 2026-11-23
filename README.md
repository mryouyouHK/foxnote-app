# Fox Note (macOS client source)

Fox Note 是一款面向 Mac 的本地优先 Markdown 笔记应用。本仓库只包含客户端运行所需源码，
安装包（DMG）通过 GitHub Releases 单独分发，不包含在本仓库中。

## 目录结构

- `foxnote.html`：界面、编辑器、Markdown 解析与序列化主源码
- `main.js` / `preload.js`：Electron 主进程与预加载脚本
- `package.json` / `package-lock.json`：依赖与版本声明
- `tools/`、`quickaction/`：辅助工具与 macOS 快速操作

## 本地运行

```bash
npm install
npm start
```

构建 DMG 需要 macOS 与 `electron-builder`，构建产物请放到 Releases，不要提交二进制包。

## 排版引擎

编辑器使用的排版解析/序列化能力另有独立开源仓库：`foxnote-layout-engine`。
