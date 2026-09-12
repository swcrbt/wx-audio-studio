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

async function main() {
  const args = process.argv.slice(2);
  const upload = args.includes('--upload');
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
    qrcodeFormat: 'image',
    qrcodeOutputDest: path.join(ROOT, QR_PATH),
    pagePath,
    onProgressUpdate,
  });
  console.log(`二维码已生成：${QR_PATH}`);
  console.log('用手机微信「扫一扫 → 右上角相册 → 选择该图片」打开。');
}

main().catch((error) => {
  console.error('失败：', error && error.message ? error.message : error);
  process.exit(1);
});
