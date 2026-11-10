/* 验证：DOM 节点被 insertBefore 移动后，CSS 入场动画是否会重启（导致闪烁） */
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 300 });
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`
      <style>
        .box { width: 60px; height: 60px; background: #e2a34a; display: inline-block;
               animation: hang-in 0.22s ease; }
        @keyframes hang-in { from { opacity: 0; transform: translateY(-14px); } to { opacity: 1; transform: none; } }
      </style>
      <div id="track"><div class="box" id="a"></div><div class="box" id="b"></div></div>
    `)
  );

  const out = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const track = document.getElementById('track');
      const a = document.getElementById('a');
      const b = document.getElementById('b');
      setTimeout(() => {
        const before = a.getAnimations().map(x => ({ t: Math.round(x.currentTime), state: x.playState }));
        const opBefore = getComputedStyle(a).opacity;
        // 模拟排序：把 a 移到 b 后面（remove + insert）
        track.insertBefore(a, null);
        const after = a.getAnimations().map(x => ({ t: Math.round(x.currentTime), state: x.playState }));
        const opAfter = getComputedStyle(a).opacity;
        // 再移动一次（无实际位置变化的重复调用）
        track.insertBefore(a, null);
        const after2 = a.getAnimations().map(x => ({ t: Math.round(x.currentTime), state: x.playState }));
        resolve({ before, opBefore, after, opAfter, after2 });
      }, 600);
    })
  `);

  console.log('RESULT ' + JSON.stringify(out));
  app.quit();
});
