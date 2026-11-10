/* 诊断单个 .lnk：readShortcutLink 的返回值/报错，以及文件头信息 */
const { app, shell } = require('electron');
const fs = require('fs');

const p = process.argv[2];
app.whenReady().then(() => {
  console.log('exists:', fs.existsSync(p), 'size:', fs.statSync(p).size);
  try {
    const link = shell.readShortcutLink(p);
    console.log('readShortcutLink OK:', JSON.stringify(link));
  } catch (e) {
    console.log('readShortcutLink THREW:', e.message);
  }
  // 原始字节头部（判断是否真是 lnk 格式 / 编码）
  const buf = fs.readFileSync(p);
  console.log('head hex:', buf.slice(0, 24).toString('hex'));
  app.quit();
});
