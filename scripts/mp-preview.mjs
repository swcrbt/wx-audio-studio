#!/usr/bin/env node
/**
 * 用 miniprogram-ci 生成真机预览二维码（也可上传体验版）。
 *
 * 用途：在没有 PC 微信开发者工具的情况下，把小程序跑到真机上跑 M0 Spike。
 *
 * 配置（二选一，均不进 git）：
 * 1. 环境变量：MP_APPID、MP_PRIVATE_KEY（私钥文件路径）
 * 2. 本地文件 mp.config.json：{ "appid": "wx...", "privateKeyPath": "./private.wx....key" }
 *
 * 私钥在小程序后台「开发管理 → 开发设置 → 小程序代码上传」生成。
 *
 * 用法：
 *   node scripts/mp-preview.mjs            # 生成预览二维码 mp-qrcode.png（默认打开 spike 页）
 *   node scripts/mp-preview.mjs --upload   # 上传为体验版
 *   node scripts/mp-preview.mjs --page pages/index/index
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import ci from 'miniprogram-ci';

const ROOT = process.cwd();
const QR_PATH = 'mp-qrcode.png';
const CONFIG_PATH = path.join(ROOT, 'mp.config.json');

/** 打包时排除的目录：不参与小程序运行的文件没必要上传。 */
const IGNORES = ['node_modules/**/*', 'tests/**/*', 'docs/**/*', 'scripts/**/*', 'spikes/**/*.md'];

function loadConfig() {
  const fileConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  const appid = process.env.MP_APPID ?? fileConfig.appid;
  const privateKeyPath = process.env.MP_PRIVATE_KEY ?? fileConfig.privateKeyPath;

  if (!appid || !privateKeyPath) {
    console.error(
      [
        '缺少小程序配置。请任选其一：',
        '  A. 创建 mp.config.json：{ "appid": "wx...", "privateKeyPath": "./private.wx....key" }',
        '  B. 设置环境变量：MP_APPID=wx... MP_PRIVATE_KEY=/path/to/private.key',
        '',
        '私钥获取：小程序后台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成密钥。',
        '（mp.config.json 与私钥均已在 .gitignore 中，不会被提交）',
      ].join('\n'),
    );
    process.exit(1);
  }

  const resolvedKey = path.isAbsolute(privateKeyPath)
    ? privateKeyPath
    : path.join(ROOT, privateKeyPath);
  if (!fs.existsSync(resolvedKey)) {
    console.error(`私钥文件不存在：${resolvedKey}`);
    process.exit(1);
  }

  return { appid, privateKeyPath: resolvedKey };
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  // 微信要求版本号为数字与点：用基础版本 + 分钟级时间戳，保证每次上传可区分
  return `${pkg.version}.${stamp}`;
}

/** 把二维码放进共享存储（相册能扫到）并尝试触发媒体库扫描。 */
function publishQrCodeToGallery(sourcePath) {
  const candidates = ['/sdcard/Pictures', '/storage/emulated/0/Pictures', '/sdcard/DCIM/Camera'];
  let published = null;
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) continue;
      const target = path.join(dir, path.basename(sourcePath));
      fs.copyFileSync(sourcePath, target);
      published = target;
      break;
    } catch {
      // 可能是未授予存储权限：继续尝试下一个候选目录
    }
  }

  if (!published) {
    console.log('· 无法写入共享目录（如 /sdcard/Pictures）：若想从相册扫码，请先执行 termux-setup-storage');
    return;
  }

  console.log(`· 已复制到共享目录：${published}`);
  try {
    execFileSync('termux-media-scan', [published], { stdio: 'ignore' });
    console.log('· 已触发媒体库扫描（termux-media-scan）');
  } catch {
    console.log('· 未安装 termux-api，未能自动扫描：打开系统相册/文件管理器刷新一次即可看到');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const upload = args.includes('--upload');
  const terminalQr = args.includes('--terminal');
  const pageIndex = args.indexOf('--page');
  const pagePath = pageIndex >= 0 ? args[pageIndex + 1] : 'spikes/index/index';
  const { appid, privateKeyPath } = loadConfig();

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: ROOT,
    privateKeyPath,
    ignores: IGNORES,
  });

  const setting = {
    es6: true,
    minify: false,
    autoPrefixWXSS: false,
    ignoreUploadUnusedFiles: true,
  };

  const onProgressUpdate = (task) => {
    if (task && typeof task.message === 'string') console.log(`[ci] ${task.message}`);
  };

  if (upload) {
    console.log('上传体验版…');
    await ci.upload({
      project,
      version: readVersion(),
      desc: `M0 spike ${new Date().toISOString()}`,
      setting,
      onProgressUpdate,
    });
    console.log('上传完成。在微信「发现 → 小程序」或后台体验版二维码中打开。');
    return;
  }

  console.log(`生成预览二维码（打开页面：${pagePath}）…`);
  await ci.preview({
    project,
    desc: `M0 spike ${new Date().toISOString()}`,
    setting,
    qrcodeFormat: terminalQr ? 'terminal' : 'image',
    qrcodeOutputDest: path.join(ROOT, QR_PATH),
    pagePath,
    onProgressUpdate,
  });

  if (terminalQr) {
    console.log('\n上方即为预览二维码：用另一台设备的微信扫它（同一台手机无法扫自己的屏）。');
    console.log('若要通过相册扫码，改用不带 --terminal 的默认方式。');
    return;
  }

  console.log(`二维码已生成：${QR_PATH}`);
  publishQrCodeToGallery(path.join(ROOT, QR_PATH));
  console.log('\n打开小程序的方式（任选其一）：');
  console.log('  ① 微信 → 文件传输助手 → 发这张图给自己 → 长按图片 → 「识别图中二维码」（最通用）');
  console.log('  ② 微信 → 扫一扫 → 右上角「相册」→ 选这张图');
  console.log('  ③ 另一台设备的微信扫本终端里 `npm run mp:preview -- --terminal` 打印的二维码');
}

main().catch((error) => {
  console.error('失败：', error && error.message ? error.message : error);
  process.exit(1);
});
