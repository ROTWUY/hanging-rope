/**
 * 生成应用图标：从矢量母版 assets/icon.svg 渲染
 * 产物：assets/icon.png (256x256，打包/窗口用)、assets/tray.png (32x32，托盘用)
 * 依赖：@resvg/resvg-js（devDependency，SVG 高质量栅格化）
 * 用法：npm run icons
 *
 * 母版说明（1024x1024 viewBox）：
 *   深色圆角方形底 + 三张黄/绿/蓝黄金比例(1:1.618)圆角卡片横向错落堆叠，
 *   每张卡片顶部中间一个小穿孔，象征「挂上的文件」。改图标请改 icon.svg。
 */
const fs = require('fs');
const path = require('path');

let Resvg;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch {
  console.error('缺少依赖 @resvg/resvg-js，请先执行: npm i -D @resvg/resvg-js');
  process.exit(1);
}

const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8');

const OUT = [
  ['icon.png', 256],
  ['tray.png', 32],
];

for (const [name, size] of OUT) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng();
  fs.writeFileSync(path.join(__dirname, '..', 'assets', name), png);
  console.log('written', name, size + 'x' + size, png.length + ' bytes');
}
