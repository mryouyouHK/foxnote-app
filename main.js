const { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItem, nativeImage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

const dirHandles = new Map();
const OPENABLE_EXT = /\.(md|markdown|txt|text)$/i;
const INLINE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const MAX_INLINE_IMAGE = 6 * 1024 * 1024;
const pendingOpenFiles = [];

/* ---------- 应用图标配色 ---------- */
const ICON_VARIANTS = {
  defaultIcon: { name: '默认', file: 'FoxNote.icns' },
  liuyun:   { name: '流云', file: 'Zen_liuyun.icns' },
  muxia:    { name: '暮霞', file: 'Zen_muxia.icns' },
  chunxi:   { name: '春汐', file: 'Zen_chunxi.icns' },
  danju:    { name: '丹橘', file: 'Zen_danju.icns' },
  songlan:  { name: '松岚', file: 'Zen_songlan.icns' },
  qingying: { name: '青萤', file: 'Zen_qingying.icns' },
  taihen:   { name: '苔痕', file: 'Zen_taihen.icns' },
  bingtan:  { name: '冰潭', file: 'Zen_bingtan.icns' },
  jiguang:  { name: '极光', file: 'Zen_jiguang.icns' },
  huying:   { name: '湖影', file: 'Zen_huying.icns' },
  yelan:    { name: '夜阑', file: 'Zen_yelan.icns' },
  yuehua:   { name: '月华', file: 'Zen_yuehua.icns' },
  ziteng:   { name: '紫藤', file: 'Zen_ziteng.icns' },
  yanmi:    { name: '烟幂', file: 'Zen_yanmi.icns' },
  xuanmo:   { name: '玄墨', file: 'Zen_xuanmo.icns' },
  chixia:   { name: '赤霞', file: 'Zen_chixia.icns' },
  liunian:  { name: '流年', file: 'Zen_liunian.icns' },
  suxin:    { name: '素心', file: 'Zen_suxin.icns' },
  liujin:   { name: '鎏金', file: 'Zen_liujin.icns' },
  mobai:    { name: '墨白', file: 'Zen_mobai.icns' }
};
const ICON_PREF_FILE = path.join(app.getPath('userData'), 'icon-preference.json');
let currentIconVariant = 'defaultIcon';
function readIconPref() {
  try {
    const j = JSON.parse(fs.readFileSync(ICON_PREF_FILE, 'utf8'));
    if (j && ICON_VARIANTS[j.variant]) return j.variant;
  } catch (e) {}
  return 'defaultIcon';
}
function writeIconPref(v) {
  try {
    fs.mkdirSync(path.dirname(ICON_PREF_FILE), { recursive: true });
    fs.writeFileSync(ICON_PREF_FILE, JSON.stringify({ variant: v }));
  } catch (e) {}
}
function isBundled() {
  return fs.existsSync(path.join(process.resourcesPath, 'FoxNote.icns'));
}
function iconDir() {
  const dev = path.join(__dirname, 'assets');
  return fs.existsSync(path.join(dev, 'FoxNote.icns')) ? dev : process.resourcesPath;
}
function iconPathFor(v) {
  const meta = ICON_VARIANTS[v] || ICON_VARIANTS.defaultIcon;
  const dir = iconDir();
  // 默认图标必须从只读源文件读取：bundle 内 FoxNote.icns 会被切换覆盖，
  // 若以它为源则切回默认时「源=目标」，无法还原原始橙色狐狸头。
  let file = meta.file;
  if (!ICON_VARIANTS[v] || v === 'defaultIcon') {
    const src = path.join(dir, 'FoxNoteSource.icns');
    if (fs.existsSync(src)) file = 'FoxNoteSource.icns';
  }
  const p = path.join(dir, file);
  return fs.existsSync(p) ? p : null;
}
function applyAppIcon(v, persist) {
  if (!ICON_VARIANTS[v]) v = 'defaultIcon';
  currentIconVariant = v;
  writeIconPref(v);
  const p = iconPathFor(v);
  if (!p) return v;
  // 1. 立即更新 Dock 图标：显式传 NativeImage，避免部分系统不识别路径参数
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (typeof app.setIcon === 'function') app.setIcon(img);
      if (app.dock && typeof app.dock.setIcon === 'function') app.dock.setIcon(img);
    }
  } catch (e) {}
  // 2. 持久化到 bundle 的 CFBundleIconFile，访达中的应用图标才会真正改变
  if (isBundled()) {
    try {
      const bundleRoot = path.dirname(path.dirname(process.resourcesPath));
      const bundleIcon = path.join(process.resourcesPath, 'FoxNote.icns');
      const target = fs.readFileSync(p);
      if (!fs.readFileSync(bundleIcon).equals(target)) {
        fs.writeFileSync(bundleIcon, target);
        execFile('touch', [bundleRoot], () => {});
        if (persist) execFile('codesign', ['--force', '--deep', '--sign', '-', bundleRoot], () => {});
      }
    } catch (e) {}
  }
  return v;
}

/* 兼容其他工具导出的 Markdown：把相对路径图片内嵌为 data URI，避免附件路径失效 */
function inlineMarkdownAssets(text, baseDir) {
  return String(text).replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:&quot;|")([^"&]*)(?:&quot;|"))?\)/g,
    (m, alt, src, title) => {
      if (/^(data:|https?:|file:)/i.test(src)) return m;
      let rel = src;
      try { rel = decodeURIComponent(src.split(/[?#]/)[0]); } catch (e) {}
      if (!INLINE_IMAGE_EXT.test(rel)) return m;
      const fp = path.resolve(baseDir, rel);
      try {
        if (!fs.statSync(fp).isFile()) return m;
        const ext = path.extname(fp).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : (ext === 'svg' ? 'svg+xml' : ext);
        const t = title ? ' "' + title + '"' : '';
        const st = fs.statSync(fp);
        if (st.size <= MAX_INLINE_IMAGE) {
          const data = 'data:image/' + mime + ';base64,' + fs.readFileSync(fp).toString('base64');
          return '![' + alt + '](' + data + t + ')';
        }
        return '![' + alt + '](' + pathToFileURL(fp).href + t + ')';
      } catch (e) {
        return m;
      }
    }
  );
}
function readMarkdownWithAssets(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    name: path.basename(filePath, path.extname(filePath)),
    path: filePath,
    text: inlineMarkdownAssets(text, path.dirname(filePath))
  };
}
ipcMain.handle('fox-read-markdown-file', async (event, filePath) => {
  if (typeof filePath !== 'string' || !fs.existsSync(filePath)) throw new Error('文件不存在');
  return readMarkdownWithAssets(filePath);
});

/* Finder「打开方式」/ Quick Action 打开的文件，先排队，窗口就绪后导入 */
function queueOpenFile(p) {
  if (typeof p !== 'string' || !OPENABLE_EXT.test(p)) return;
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) pendingOpenFiles.push(p);
  } catch (e) {}
}
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  queueOpenFile(filePath);
  if (app.isReady()) deliverPendingFiles();
});
function takePendingFileItems() {
  const items = [];
  while (pendingOpenFiles.length) {
    const p = pendingOpenFiles.shift();
    try {
      if (!OPENABLE_EXT.test(p) || !fs.statSync(p).isFile()) continue;
      items.push(readMarkdownWithAssets(p));
    } catch (e) {}
  }
  return items;
}
function deliverPendingFiles(targetWin) {
  if (!app.isReady()) return;
  const items = takePendingFileItems();
  if (!items.length) return;
  const win = (targetWin && !targetWin.isDestroyed() && targetWin.__foxMain)
    ? targetWin
    : BrowserWindow.getAllWindows().find(w => w.__foxMain && !w.isDestroyed());
  if (!win) {
    pendingOpenFiles.unshift(...items.map(x => x.path));
    return;
  }
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('fox-open-files', items);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/* ---------- LaunchServices：文档类型图标 + 清理历史版本 ---------- */
const QUICK_ACTION_NAME = '用 Fox Note 打开.workflow';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const APP_BUNDLE_NAME = 'Fox Note.app';
const INSTALLED_APP = '/Applications/Fox Note.app';

function lsRun(args, timeout) {
  return new Promise(resolve => {
    try {
      execFile(LSREGISTER, args, { timeout: timeout || 10000, maxBuffer: 64 * 1024 * 1024 },
        (err, out) => resolve({ ok: !err, out: out || '' }));
    } catch (e) { resolve({ ok: false, out: '' }); }
  });
}
// 由当前可执行文件路径反推外层 .app bundle（开发态无 .app 则返回 null）
function currentAppBundle() {
  const parts = process.execPath.split(path.sep);
  const idx = parts.findIndex(p => /\.app$/i.test(p));
  if (idx < 0) return null;
  const bundle = parts.slice(0, idx + 1).join(path.sep);
  // 打包后应为 Fox Note.app；开发态落到 Electron.app 时不参与清理
  return new RegExp('/' + APP_BUNDLE_NAME.replace('.', '\\.') + '$').test(bundle) ? bundle : null;
}
// 读取 bundle 的短版本号，用于挑选「最新版」注册
function bundleVersion(bundle) {
  try {
    const s = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(s);
    return m ? m[1].trim() : '0';
  } catch (e) { return '0'; }
}
// 启动时清理 LaunchServices：注销所有历史版本（含 DMG 卷、构建目录、Electron Helper 子 app），
// 只保留版本号最高的那个 bundle 并强制重注册，确保 Finder「打开方式」只出现最新版。
function refreshFileAssociations() {
  if (process.platform !== 'darwin') return;
  // 正式安装位置是覆盖安装的目标，优先把它作为唯一保留版本；
  // DMG 挂载卷是临时的，退出后消失，绝不能成为唯一 handler。未安装时才退回当前 bundle。
  const canonical = fs.existsSync(INSTALLED_APP) ? INSTALLED_APP : currentAppBundle();
  if (!canonical) return;

  (async () => {
    const dump = await lsRun(['-dump'], 20000);
    if (!dump.ok || !dump.out) return;
    const found = new Set();
    const lineRe = /^\s*path:\s+(.+?)\s+\(0x[0-9a-f]+\)\s*$/i;
    const marker = '/' + APP_BUNDLE_NAME; // /Fox Note.app，可命中 bundle 内部的 Helper 子 app
    dump.out.split('\n').forEach(line => {
      const m = lineRe.exec(line);
      if (!m) return;
      const p = m[1].trim();
      const i = p.indexOf(marker);
      if (i < 0) return;
      const after = p.charAt(i + marker.length);
      if (after && after !== path.sep) return;
      found.add(p);
    });
    for (const p of found) {
      // 保留最新 bundle 本身及其内部子 app
      if (p === canonical || p.indexOf(canonical + path.sep) === 0) continue;
      await lsRun(['-u', p], 8000); // 注销历史版本（含已卸载卷），失败忽略
    }
    // 强制重注册最新版，刷新文档类型与图标
    await lsRun(['-f', canonical], 8000);
    // 仅当保留版本或路径变化时才重启 Finder 刷新 IconServices，避免每次启动都打断用户
    try {
      const ver = bundleVersion(canonical);
      const markerPath = path.join(app.getPath('userData'), 'foxnote.iconreg.marker');
      let prev = '';
      try { prev = fs.readFileSync(markerPath, 'utf8'); } catch (e) {}
      const fp = ver + '|' + canonical;
      if (prev !== fp) {
        fs.writeFileSync(markerPath, fp);
        execFile('killall', ['Finder'], { timeout: 5000 }, () => {});
      }
    } catch (e) {}
  })().catch(() => {});
}

/* ---------- Finder 右键快速操作 ---------- */
function installQuickAction() {
  const src = path.join(__dirname, 'quickaction', QUICK_ACTION_NAME);
  if (!fs.existsSync(src)) throw new Error('快速操作模板缺失');
  const servicesDir = path.join(app.getPath('home'), 'Library', 'Services');
  const dest = path.join(servicesDir, QUICK_ACTION_NAME);
  fs.mkdirSync(servicesDir, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  try {
    execFile(LSREGISTER, ['-f', dest], { timeout: 8000 }, () => {});
  } catch (e) {}
  return dest;
}
async function promptInstallQuickAction() {
  const r = await dialog.showMessageBox({
    type: 'info',
    buttons: ['安装', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '安装 Finder 右键快速操作',
    message: '将「用 Fox Note 打开」安装到 Finder 快速操作？',
    detail: '安装后，在 Finder 中右键 .md / .txt 文件，即可通过「快速操作 → 用 Fox Note 打开」导入笔记。'
  });
  if (r.response !== 0) return;
  try {
    const dest = installQuickAction();
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['好的'],
      title: '安装完成',
      message: '已安装「用 Fox Note 打开」。',
      detail: dest
    });
  } catch (e) {
    dialog.showErrorBox('安装失败', e && e.message ? e.message : '未知错误');
  }
}
ipcMain.handle('fox-install-quick-action', () => ({ ok: true, path: installQuickAction() }));

/* ---------- 图片右键操作 ---------- */
function imageExtFromMime(mime) {
  const m = String(mime || '').toLowerCase().replace(/^image\//, '').split(';')[0];
  if (m === 'jpeg') return 'jpg';
  if (m === 'svg+xml') return 'svg';
  if (m === 'x-ms-bmp') return 'bmp';
  return /^(png|jpg|jpeg|gif|webp|svg|avif|bmp)$/.test(m) ? (m === 'jpeg' ? 'jpg' : m) : 'png';
}
async function imageBytesFromSrc(src) {
  if (typeof src !== 'string' || !src) throw new Error('图片地址为空');
  if (/^data:image\//i.test(src)) {
    const m = src.match(/^data:image\/([^;,]+);base64,([\s\S]+)$/i);
    if (!m) throw new Error('无法解析图片数据');
    return { buffer: Buffer.from(m[2], 'base64'), ext: imageExtFromMime(m[1]) };
  }
  if (/^file:\/\//i.test(src)) {
    const fp = fileURLToPath(src);
    return { buffer: fs.readFileSync(fp), ext: path.extname(fp).slice(1).toLowerCase() || 'png' };
  }
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return { buffer: Buffer.from(await r.arrayBuffer()), ext: imageExtFromMime(ct) };
  }
  const fp = path.resolve(src);
  return { buffer: fs.readFileSync(fp), ext: path.extname(fp).slice(1).toLowerCase() || 'png' };
}
ipcMain.handle('fox-image-action', async (event, action, payload) => {
  const src = payload && payload.src;
  try {
    if (action === 'copy') {
      const { buffer } = await imageBytesFromSrc(src);
      const img = nativeImage.createFromBuffer(buffer);
      if (img.isEmpty()) throw new Error('该图片格式无法复制');
      clipboard.writeImage(img);
      return { ok: true };
    }
    if (action === 'save') {
      const { buffer, ext } = await imageBytesFromSrc(src);
      const base = String((payload && payload.alt) || '图片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '图片';
      const r = await dialog.showSaveDialog({
        title: '保存图片',
        defaultPath: path.join(app.getPath('downloads'), base + '.' + ext),
        filters: [
          { name: '图片文件', extensions: [ext, 'png', 'jpg', 'webp', 'gif'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      });
      if (r.canceled || !r.filePath) return { ok: true, canceled: true };
      fs.writeFileSync(r.filePath, buffer);
      shell.showItemInFolder(r.filePath);
      return { ok: true, path: r.filePath };
    }
    if (action === 'open') {
      if (/^https?:\/\//i.test(src)) {
        await shell.openExternal(src);
        return { ok: true };
      }
      let fp = src;
      if (/^data:image\//i.test(src)) {
        const { buffer, ext } = await imageBytesFromSrc(src);
        fp = path.join(app.getPath('temp'), 'foxnote-image-' + Date.now() + '.' + ext);
        fs.writeFileSync(fp, buffer);
      } else if (/^file:\/\//i.test(src)) {
        fp = fileURLToPath(src);
      } else {
        fp = path.resolve(src);
      }
      const err = await shell.openPath(fp);
      if (err) throw new Error(err);
      return { ok: true, path: fp };
    }
    return { ok: false, error: '未知操作' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : '图片操作失败' };
  }
});

let seq = 1;
function nextId() { return 'd' + (seq++) + '_' + Date.now().toString(36); }
function registerDir(p, id) {
  const key = id || nextId();
  dirHandles.set(key, p);
  return { id: key, name: path.basename(p), path: p };
}
function getDir(id) {
  const p = dirHandles.get(id);
  if (!p) throw new Error('目录句柄已失效，请重新选择文件夹');
  return p;
}
function safePath(id, name) {
  const dir = getDir(id);
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('非法文件名');
  }
  const fp = path.join(dir, name);
  if (path.dirname(fp) !== dir) throw new Error('非法文件路径');
  return fp;
}

ipcMain.handle('fox-home', async () => os.homedir());

/* 应用图标：读取 / 切换配色 */
ipcMain.handle('fox-get-app-icon', () => ({ variant: currentIconVariant, variants: ICON_VARIANTS }));
ipcMain.handle('fox-set-app-icon', (event, v) => {
  const variant = applyAppIcon(v, true);
  if (typeof buildMenu === 'function') buildMenu();
  let writable = true;
  if (isBundled()) {
    try { fs.accessSync(path.join(process.resourcesPath, 'FoxNote.icns'), fs.constants.W_OK); }
    catch (e) { writable = false; }
  }
  return { ok: true, variant: variant, name: ICON_VARIANTS[variant].name, writable: writable };
});

ipcMain.handle('fox-pick-dir', async (event, defaultPath) => {
  const opts = {
    title: '选择 Fox Note 笔记文件夹（可新建文件夹）',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择'
  };
  if (defaultPath && typeof defaultPath === 'string' && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
  const r = await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
  return Object.assign({ canceled: false }, registerDir(r.filePaths[0]));
});

ipcMain.handle('fox-restore-dir', async (event, info) => {
  if (!info || !info.id || typeof info.path !== 'string') return null;
  if (!dirHandles.has(info.id)) {
    try { fs.accessSync(info.path, fs.constants.R_OK | fs.constants.W_OK); }
    catch (e) { return null; }
    dirHandles.set(info.id, info.path);
  }
  return { id: info.id, name: info.name || path.basename(info.path), path: info.path };
});

ipcMain.handle('fox-dir-mkdir', async (event, id, name, create) => {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) throw new Error('非法文件夹名');
  const target = path.join(getDir(id), name);
  if (!fs.existsSync(target)) {
    if (!create) throw new Error('文件夹不存在');
    fs.mkdirSync(target, { recursive: true });
  }
  return registerDir(target);
});

ipcMain.handle('fox-dir-touch', async (event, id, name) => {
  const fp = safePath(id, name);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf8');
  return true;
});

ipcMain.handle('fox-dir-list', async (event, id) => {
  const dir = getDir(id);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name);
});

ipcMain.handle('fox-dir-read', async (event, id, name) => {
  const fp = safePath(id, name);
  const st = fs.statSync(fp);
  return { content: fs.readFileSync(fp, 'utf8'), lastModified: st.mtimeMs };
});

ipcMain.handle('fox-dir-write', async (event, id, name, text) => {
  const fp = safePath(id, name);
  fs.writeFileSync(fp, String(text == null ? '' : text), 'utf8');
  return true;
});

ipcMain.handle('fox-dir-remove', async (event, id, name) => {
  const fp = safePath(id, name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return true;
});

ipcMain.handle('fox-open-external', async (event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

/* ---------- WebDAV 目录浏览：PROPFIND 列目录 / MKCOL 新建文件夹 ---------- */
// 用 Node 原生 http/https 发请求，绕过渲染进程的 CORS 限制
function wdRequest(url, method, user, pass, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址格式不正确')); }
    const mod = u.protocol === 'https:' ? https : http;
    const auth = 'Basic ' + Buffer.from((user || '') + ':' + (pass || ''), 'utf8').toString('base64');
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + (u.search || ''), method: method,
      headers: Object.assign({
        'Authorization': auth,
        'User-Agent': 'FoxNote/1.0'
      }, headers || {})
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}
// WebDAV 地址：可填目录或具体文件；浏览时统一取其所在目录（以 / 结尾）
function wdDirUrl(url) {
  let u = (url || '').trim();
  if (!u) return '';
  if (/\.(json|txt|md)(\?.*)?$/i.test(u)) u = u.replace(/\/[^/]*$/, '');
  return u.replace(/\/+$/, '') + '/';
}
// 解析 PROPFIND 的 XML：返回 {href, name, isDir, fullUrl}
function wdParsePropfind(xml, baseDir) {
  const items = [];
  // 兼容 <response>、<d:response> 等前缀
  const respRe = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let m;
  while ((m = respRe.exec(xml)) !== null) {
    const block = m[1];
    const hrefM = block.match(/<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i);
    if (!hrefM) continue;
    let href = hrefM[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    try { href = decodeURIComponent(href); } catch (e) {}
    const isDir = /<(?:[\w-]+:)?resourcetype\b[^>]*>[\s\S]*?<(?:[\w-]+:)?collection\b/i.test(block);
    let full;
    try { full = new URL(href, baseDir).href; } catch (e) { continue; }
    // 目录本身（href 与 baseDir 等价）跳过
    const norm = s => s.replace(/\/+$/, '');
    if (norm(full) === norm(baseDir)) continue;
    let name = full.replace(/\/+$/, '').split('/').pop() || full;
    try { name = decodeURIComponent(name); } catch (e) {}
    items.push({ href: href, name: name, isDir: isDir, fullUrl: full });
  }
  return items;
}

// 列出 WebDAV 目录下所有文件夹（含文件，标记 isDir）
ipcMain.handle('fox-webdav-list', async (event, url, user, pass) => {
  const dir = wdDirUrl(url);
  if (!dir) throw new Error('请先填写 WebDAV 地址');
  const r = await wdRequest(dir, 'PROPFIND', user, pass, {
    'Depth': '1',
    'Content-Type': 'application/xml; charset=utf-8'
  }, '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/><d:getlastmodified/></d:prop></d:propfind>');
  if (r.status === 401 || r.status === 403) throw new Error('认证失败：请使用应用专用密码（非登录密码）');
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  const items = wdParsePropfind(r.body, dir);
  // 文件夹排前、文件排后，各自按名称排序
  items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
  return { dir: dir, items: items };
});

// 新建 WebDAV 文件夹
ipcMain.handle('fox-webdav-mkdir', async (event, url, user, pass, name) => {
  const dir = wdDirUrl(url);
  if (!dir) throw new Error('请先填写 WebDAV 地址');
  if (typeof name !== 'string' || !name.trim() || /[\/\\]/.test(name)) throw new Error('文件夹名不合法');
  const target = dir + encodeURIComponent(name.trim()) + '/';
  const r = await wdRequest(target, 'MKCOL', user, pass, {}, null);
  if (r.status === 201 || r.status === 200) return { ok: true, url: target, name: name.trim() };
  if (r.status === 405 || r.status === 409) throw new Error('文件夹已存在或父目录不可写');
  if (r.status === 401 || r.status === 403) throw new Error('认证失败：请使用应用专用密码');
  throw new Error('HTTP ' + r.status);
});

/* ---------- WebDAV 单文件读写 / 删除（Markdown 同步） ---------- */
// PUT 文本文件
ipcMain.handle('fox-webdav-put', async (event, url, user, pass, text, contentType) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('地址不合法');
  const body = typeof text === 'string' ? text : '';
  const r = await wdRequest(url, 'PUT', user, pass, {
    'Content-Type': contentType || 'text/markdown; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8')
  }, body);
  if (r.status === 401 || r.status === 403) throw new Error('认证失败：请使用应用专用密码（非登录密码）');
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  return { ok: true, status: r.status };
});
// GET 文本文件（404 不视为错误）
ipcMain.handle('fox-webdav-get', async (event, url, user, pass) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('地址不合法');
  const r = await wdRequest(url, 'GET', user, pass, {}, null);
  if (r.status === 404) return { ok: false, status: 404, text: '' };
  if (r.status === 401 || r.status === 403) throw new Error('认证失败：请使用应用专用密码（非登录密码）');
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  return { ok: true, status: r.status, text: r.body };
});
// DELETE 文件（404 视为已删除）
ipcMain.handle('fox-webdav-del', async (event, url, user, pass) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('地址不合法');
  const r = await wdRequest(url, 'DELETE', user, pass, {}, null);
  if (r.status === 404) return { ok: true, status: 404 };
  if (r.status === 401 || r.status === 403) throw new Error('认证失败：请使用应用专用密码（非登录密码）');
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  return { ok: true, status: r.status };
});

/* ---------- 页面缩放：主进程 webContents.setZoomFactor ---------- */
const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
const zoomByWin = new WeakMap();
function clampZoom(z) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100)); }
function setZoom(win, z) {
  z = clampZoom(z);
  zoomByWin.set(win, z);
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(z);
  return z;
}
function getZoom(win) {
  return zoomByWin.get(win) || (win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1);
}
ipcMain.handle('fox-zoom-get', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return getZoom(win);
});
ipcMain.handle('fox-zoom-set', (event, z) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return setZoom(win, Number(z));
});
ipcMain.handle('fox-zoom-step', (event, dir) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return setZoom(win, getZoom(win) + (dir > 0 ? ZOOM_STEP : -ZOOM_STEP));
});

/* ---------- 菜单动作转发到页面 ---------- */
function sendAction(action) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('fox-menu-action', action);
}

/* ---------- 中文应用菜单 ---------- */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const appName = 'Fox Note';
  const tpl = [];

  if (isMac) {
    tpl.push({
      label: appName,
      submenu: [
        { label: '关于 ' + appName, role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: () => sendAction('settings') },
        { label: '切换应用图标', submenu: Object.keys(ICON_VARIANTS).map(k => ({
          label: ICON_VARIANTS[k].name + (currentIconVariant === k ? '  ✓' : ''),
          click: () => sendAction('icon:' + k)
        })) },
        { type: 'separator' },
        { label: '服务', role: 'services' },
        { type: 'separator' },
        { label: '隐藏 ' + appName, role: 'hide' },
        { label: '隐藏其他', role: 'hideOthers' },
        { label: '显示全部', role: 'showAll' },
        { type: 'separator' },
        { label: '退出 ' + appName, role: 'quit', accelerator: 'Cmd+Q' }
      ]
    });
  }

  tpl.push({
    label: '文件',
    submenu: [
      { label: '新建笔记', accelerator: 'CmdOrCtrl+N', click: () => sendAction('new') },
      { label: '新建标签目录…', click: () => sendAction('new-folder') },
      { label: '导入笔记…', accelerator: 'CmdOrCtrl+O', click: () => sendAction('import') },
      { type: 'separator' },
      { label: '在新窗口打开', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendAction('open-note-window') },
      { label: '版本历史…', click: () => sendAction('history') },
      { type: 'separator' },
      { label: '导出', submenu: [
        { label: 'Markdown (.md)', click: () => sendAction('exp-md') },
        { label: '网页 (.html)', click: () => sendAction('exp-html') },
        { label: '纯文本 (.txt)', click: () => sendAction('exp-txt') },
        { label: 'PDF (.pdf)', click: () => sendAction('exp-pdf') }
      ] },
      { type: 'separator' },
      { label: '设置…', accelerator: 'Cmd+,', click: () => sendAction('settings') },
      { type: 'separator' },
      { label: '关闭窗口', role: 'close', accelerator: 'CmdOrCtrl+W' }
    ]
  });

  tpl.push({
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' },
      { type: 'separator' },
      // Tab / Shift+Tab 由页面编辑器内 keydown 直接处理，避免与焦点切换冲突，故仅保留点击入口
      { label: '增加缩进', click: () => sendAction('indent') },
      { label: '减少缩进', click: () => sendAction('outdent') },
      { type: 'separator' },
      { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => sendAction('search') },
      { type: 'separator' },
      { label: '拼写与语法检查', click: () => sendAction('toggle-spellcheck') },
      { label: '荧光笔', submenu: [
        { label: '黄色', click: () => sendAction('hl-y') },
        { label: '绿色', click: () => sendAction('hl-g') },
        { label: '蓝色', click: () => sendAction('hl-b') },
        { label: '红色', click: () => sendAction('hl-r') },
        { label: '紫色', click: () => sendAction('hl-p') }
      ] }
    ]
  });

  tpl.push({
    label: '显示',
    submenu: [
      { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => sendAction('zoom-in') },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => sendAction('zoom-out') },
      { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => sendAction('zoom-reset') },
      { type: 'separator' },
      { label: 'Markdown 源码', click: () => sendAction('view-edit') },
      { label: '双栏', click: () => sendAction('view-split') },
      { label: '所见即所得', click: () => sendAction('view-preview') },
      { type: 'separator' },
      { label: '显示/隐藏统计', click: () => sendAction('toggle-stats') },
      { label: '显示/隐藏左侧栏', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendAction('toggle-leftnav') },
      { type: 'separator' },
      { label: '进入全屏', role: 'togglefullscreen' }
    ]
  });

  tpl.push({
    label: '工具',
    submenu: [
      { label: '文本 DIFF 对比', accelerator: 'CmdOrCtrl+Shift+D', click: () => createDiffWindow() },
      { type: 'separator' },
      { label: 'iCloud Drive 设置…', click: () => sendAction('icloud-setup') },
      { label: '目录 / 标签管理…', click: () => sendAction('folder-manage') },
      { label: '切换应用图标', submenu: Object.keys(ICON_VARIANTS).map(k => ({
        label: ICON_VARIANTS[k].name + (currentIconVariant === k ? '  ✓' : ''),
        click: () => sendAction('icon:' + k)
      })) },
      { type: 'separator' },
      { label: '加密笔记 / 解锁…', click: () => sendAction('encrypt') },
      { label: '取消笔记加密…', click: () => sendAction('decrypt') },
      { type: 'separator' },
      { label: '安装 Finder 右键快速操作…', click: () => { promptInstallQuickAction().catch(() => {}); } }
    ]
  });

  tpl.push({
    label: '窗口',
    submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '缩放', role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { label: '前置全部窗口', role: 'front' }] : []),
      { type: 'separator' },
      { label: '全部置于顶层', click: () => {
        for (const w of BrowserWindow.getAllWindows()) w.setAlwaysOnTop(!w.isAlwaysOnTop());
      } }
    ]
  });

  tpl.push({
    label: '帮助',
    submenu: [
      { label: appName + ' 帮助', click: () => sendAction('help') }
    ]
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Fox Note',
    // 无边框标题栏：红黄绿三点与页面顶栏融为一体（macOS 原生三点保留）
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.__foxMain = true;
  // 外部超链接统一交给系统默认浏览器打开，不在 Electron 内新开窗口。
  // file:// / about:blank 等内部窗口请求保持默认行为，避免误伤单文档窗口。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.loadFile(path.join(__dirname, 'foxnote.html'));
  win.webContents.once('did-finish-load', () => deliverPendingFiles(win));
}

/* ---------- 导出 PDF ---------- */
ipcMain.handle('fox-export-pdf', async (event, html, defaultName) => {
  const r = await dialog.showSaveDialog({
    title: '导出为 PDF',
    defaultPath: (os.homedir() + '/Downloads/' + (defaultName || 'Fox Note')).replace(/\.pdf$/i, '') + '.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await w.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    });
    fs.writeFileSync(r.filePath, pdf);
    w.destroy();
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

/* ---------- 文本 Diff 对比工具（独立窗口） ---------- */
ipcMain.handle('fox-open-diff', () => { createDiffWindow(); return true; });
let diffWin = null;
function createDiffWindow() {
  if (diffWin && !diffWin.isDestroyed()) {
    diffWin.focus();
    return;
  }
  diffWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: '文本 DIFF 对比工具',
    // 工具自带深色 header，用系统默认标题栏，避免原生三点盖住品牌区
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  diffWin.loadFile(path.join(__dirname, 'tools', 'diff.html'));
  diffWin.on('closed', () => { diffWin = null; });
}

/* ---------- 单文档独立窗口（只打开一篇笔记，不可切换） ---------- */
ipcMain.handle('fox-open-note-window', (event, id) => createNoteWindow(id));
const noteDocWindows = new Map();
function createNoteWindow(id) {
  if (typeof id !== 'string' || !id.trim()) return false;
  const existing = noteDocWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return true;
  }
  if (existing) noteDocWindows.delete(id);
  const win = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    title: 'Fox Note',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'foxnote.html'), { query: { single: '1', note: id } });
  noteDocWindows.set(id, win);
  win.on('closed', () => { if (noteDocWindows.get(id) === win) noteDocWindows.delete(id); });
  return true;
}

app.whenReady().then(() => {
  applyAppIcon(readIconPref());
  process.argv.forEach(queueOpenFile);
  buildMenu();
  createWindow();
  refreshFileAssociations();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
