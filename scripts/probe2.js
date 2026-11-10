/** 诊断脚本 2：验证剪贴板文件解析 + .lnk 快捷方式解析 */
const { app, clipboard, shell } = require('electron');
const fs = require('fs');

function readClipboardFiles() {
  const raw = [];
  const pushList = (s) => {
    if (!s) return;
    for (const part of String(s).split('\0')) {
      const p = part.replace(/\0/g, '').trim();
      if (p) raw.push(p);
    }
  };
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (buf && buf.length) pushList(buf.toString('utf16le'));
  } catch (e) {
    console.log('readBuffer FileNameW error', e.message);
  }
  if (!raw.length) {
    try { pushList(clipboard.read('FileName')); } catch {}
  }
  const seen = new Set();
  return raw.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return fs.existsSync(p);
  });
}

app.whenReady().then(() => {
  console.log('clipboard files =>', JSON.stringify(readClipboardFiles()));

  for (const lnk of [
    'C:\\Users\\ROTWU\\Desktop\\滴答清单.lnk',
    'C:\\Users\\Public\\Desktop\\Excel.lnk',
  ]) {
    try {
      const link = shell.readShortcutLink(lnk);
      const exists = link && link.target ? fs.existsSync(link.target) : false;
      console.log(`lnk ${lnk} => target=${link && link.target} exists=${exists}`);
    } catch (e) {
      console.log(`lnk ${lnk} => ERROR ${e.message}`);
    }
  }
  app.quit();
});
