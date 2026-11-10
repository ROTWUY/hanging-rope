/** 诊断脚本：打印剪贴板里所有可用格式，用于确认“复制文件”的可读格式 */
const { app, clipboard } = require('electron');

app.whenReady().then(() => {
  const out = [];
  out.push('availableFormats: ' + JSON.stringify(clipboard.availableFormats()));
  const tryRead = (fmt) => {
    try {
      const v = clipboard.read(fmt);
      out.push(`read('${fmt}') => ${JSON.stringify(v)}`);
    } catch (e) {
      out.push(`read('${fmt}') ERROR ${e.message}`);
    }
  };
  const tryBuf = (fmt) => {
    try {
      const b = clipboard.readBuffer(fmt);
      out.push(`readBuffer('${fmt}') => ${b ? b.length + ' bytes ' + b.toString('hex').slice(0, 120) : 'null'}`);
    } catch (e) {
      out.push(`readBuffer('${fmt}') ERROR ${e.message}`);
    }
  };
  ['FileNameW', 'FileName', 'CF_HDROP', 'text/plain', 'text/uri-list'].forEach(tryRead);
  ['CF_HDROP', 'FileNameW'].forEach(tryBuf);
  console.log(out.join('\n'));
  app.quit();
});
