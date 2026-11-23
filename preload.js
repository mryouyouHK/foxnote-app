const { contextBridge, ipcRenderer } = require('electron');

// 只暴露可被结构化克隆的普通数据接口；目录/文件句柄的包装在页面主世界完成
contextBridge.exposeInMainWorld('__electronFs', {
  isElectron: true,
  async homePath() { return await ipcRenderer.invoke('fox-home'); },
  getAppIcon: () => ipcRenderer.invoke('fox-get-app-icon'),
  setAppIcon: v => ipcRenderer.invoke('fox-set-app-icon', v),
  async exportPdf(html, name) { return await ipcRenderer.invoke('fox-export-pdf', html, name); },
  async pickDirectory(defaultPath) {
    const r = await ipcRenderer.invoke('fox-pick-dir', defaultPath);
    if (r.canceled) {
      const e = new DOMException('User cancelled directory picker', 'AbortError');
      throw e;
    }
    return { id: r.id, name: r.name, path: r.path };
  },
  async restoreDirectory(info) {
    const r = await ipcRenderer.invoke('fox-restore-dir', info);
    return r ? { id: r.id, name: r.name, path: r.path } : null;
  },
  listFiles: id => ipcRenderer.invoke('fox-dir-list', id),
  readFile: (id, name) => ipcRenderer.invoke('fox-dir-read', id, name),
  writeFile: (id, name, text) => ipcRenderer.invoke('fox-dir-write', id, name, text),
  touchFile: (id, name) => ipcRenderer.invoke('fox-dir-touch', id, name),
  makeDir: (id, name, create) => ipcRenderer.invoke('fox-dir-mkdir', id, name, create),
  removeEntry: (id, name) => ipcRenderer.invoke('fox-dir-remove', id, name),
  openExternal: url => ipcRenderer.invoke('fox-open-external', url),
  // 打开文本 Diff 对比工具（独立窗口）
  openDiffTool: () => ipcRenderer.invoke('fox-open-diff'),
  // 打开单文档独立窗口（仅当前笔记，不可切换）
  openNoteWindow: id => ipcRenderer.invoke('fox-open-note-window', id),
  // 页面缩放
  zoomGet: () => ipcRenderer.invoke('fox-zoom-get'),
  zoomSet: z => ipcRenderer.invoke('fox-zoom-set', z),
  zoomStep: dir => ipcRenderer.invoke('fox-zoom-step', dir),
  // WebDAV 目录浏览 / 新建文件夹
  webdavList: (url, user, pass) => ipcRenderer.invoke('fox-webdav-list', url, user, pass),
  webdavMkdir: (url, user, pass, name) => ipcRenderer.invoke('fox-webdav-mkdir', url, user, pass, name),
  // WebDAV 单文件读写 / 删除（Markdown 同步）
  webdavPut: (url, user, pass, text, type) => ipcRenderer.invoke('fox-webdav-put', url, user, pass, text, type),
  webdavGet: (url, user, pass) => ipcRenderer.invoke('fox-webdav-get', url, user, pass),
  webdavDel: (url, user, pass) => ipcRenderer.invoke('fox-webdav-del', url, user, pass),
  // 原生菜单动作
  onMenuAction: cb => ipcRenderer.on('fox-menu-action', (e, action) => cb(action)),
  // Finder「打开方式」/ Quick Action 传入的文件
  onOpenFiles: cb => ipcRenderer.on('fox-open-files', (e, items) => cb(items)),
  // 读取 Markdown 并内嵌相对路径图片
  readMarkdownFile: filePath => ipcRenderer.invoke('fox-read-markdown-file', filePath),
  // 安装 Finder 右键快速操作
  installQuickAction: () => ipcRenderer.invoke('fox-install-quick-action'),
  // 图片右键操作：copy / save / open
  imageAction: (action, payload) => ipcRenderer.invoke('fox-image-action', action, payload)
});
