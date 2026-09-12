#!/usr/bin/env node
/**
 * 起一个只读的局域网 HTTP 服务，把预览二维码暴露出去。
 *
 * 用途：微信的预览码只能用**摄像头**扫（不允许图片识别），因此需要第二块屏幕显示二维码。
 * 本脚本让同一 Wi-Fi 下的电脑/平板/另一部手机用浏览器打开即可看到二维码，
 * 然后用要调试的那台手机用微信「扫一扫」对着屏幕扫。
 *
 * 用法：
 *   npm run mp:preview      # 先生成 mp-qrcode.png
 *   npm run mp:serve        # 再启动本服务，按提示在另一台设备上打开 URL
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const QR_PATH = path.join(ROOT, 'mp-qrcode.png');
const PORT = Number(process.env.QR_PORT ?? 8787);

if (!fs.existsSync(QR_PATH)) {
  console.error('找不到 mp-qrcode.png：请先执行 npm run mp:preview。');
  process.exit(1);
}

function localAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>M0 Spike 预览码</title>
       <style>body{margin:0;background:#111;color:#eee;font-family:sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
       img{width:min(70vw,70vh);image-rendering:pixelated;background:#fff;padding:16px;border-radius:8px}
       p{opacity:.7;font-size:14px;margin-top:12px}</style></head>
       <body><img src="/mp-qrcode.png" alt="预览二维码">
       <p>用要调试的手机微信「扫一扫」，对着这个屏幕扫（不要用相册识别）</p></body></html>`,
    );
    return;
  }

  if (url === '/mp-qrcode.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    fs.createReadStream(QR_PATH).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = localAddresses();
  console.log(`二维码服务已启动（图片：${path.basename(QR_PATH)}）\n`);
  console.log('在另一台设备（电脑/平板/另一部手机）的浏览器里打开下列任一地址：');
  if (addresses.length === 0) {
    console.log(`  http://<本机局域网 IP>:${PORT}/  （未检测到局域网地址，请确认已连 Wi-Fi）`);
  }
  for (const item of addresses) {
    console.log(`  http://${item.address}:${PORT}/    (${item.name})`);
  }
  console.log('\n然后用要调试的手机微信「扫一扫」，对着那台设备的屏幕扫。');
  console.log('按 Ctrl+C 停止服务。\n');
});
