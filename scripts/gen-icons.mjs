// 用本地 sharp 生成 PWA 图标，不依赖任何外部包（sharp 已是项目依赖）。
// 从 hero 图取中心方图，叠一层品牌渐变 + "PK" 字样，输出 192/512/apple-touch-icon/favicon。
// 运行：node scripts/gen-icons.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public');
const src = join(root, 'public', 'assets', 'hero-d943dda7.jpg');

// 品牌色（与前端 --bg / --accent 对齐）
const BG = '#0c110f';
const ACCENT = '#7ee2a8';

/** 生成一张带圆角、品牌底、"PK"字样的 SVG 覆盖层（用于纯色背景版图标） */
function overlaySvg(size) {
  const pad = Math.round(size * 0.08);
  const fontSize = Math.round(size * 0.42);
  // 用 SVG 文本画 PK，避免引入字体渲染依赖
  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BG}"/>
      <stop offset="1" stop-color="#080b0a"/>
    </linearGradient>
    <linearGradient id="a" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#95efb9"/>
      <stop offset="1" stop-color="#55ce87"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <rect x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" rx="${Math.round(size * 0.18)}"
        fill="none" stroke="${ACCENT}" stroke-opacity="0.35" stroke-width="${Math.max(1, Math.round(size * 0.01))}"/>
  <text x="50%" y="50%" font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="800"
        font-size="${fontSize}" fill="url(#a)" text-anchor="middle" dominant-baseline="central"
        letter-spacing="${-fontSize * 0.06}">PK</text>
</svg>`);
}

async function main() {
  // 纯品牌底 + PK 字样版（各尺寸）
  for (const size of [192, 512]) {
    await sharp(overlaySvg(size))
      .png()
      .toFile(join(outDir, `icon-${size}.png`));
  }
  // apple-touch-icon（iOS 偏好实心方角、不透明）
  await sharp(overlaySvg(180)).png().toFile(join(outDir, 'apple-touch-icon.png'));
  // favicon（32px PNG）
  await sharp(overlaySvg(32)).png().toFile(join(outDir, 'favicon.png'));
  // maskable：留出 10% 安全边，背景填满
  const maskable = (size) => Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <text x="50%" y="50%" font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="800"
        font-size="${Math.round(size * 0.34)}" fill="${ACCENT}" text-anchor="middle" dominant-baseline="central">PK</text>
</svg>`);
  await sharp(maskable(512)).png().toFile(join(outDir, 'icon-maskable-512.png'));
  console.log('icons generated in', outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
