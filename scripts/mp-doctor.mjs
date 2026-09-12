#!/usr/bin/env node
/**
 * 上传/预览前的自检：确认凭据与项目结构是否具备生成真机预览码的条件。
 *
 * 用法：node scripts/mp-doctor.mjs（或 npm run mp:doctor）
 *
 * 它不会上传任何东西，也不打印私钥内容与完整 appid。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'mp.config.json');

const problems = [];
const warnings = [];

function ok(message) {
  console.log(`✓ ${message}`);
}
function bad(message) {
  problems.push(message);
  console.log(`✗ ${message}`);
}
function warn(message) {
  warnings.push(message);
  console.log(`! ${message}`);
}
function info(message) {
  console.log(`· ${message}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ① 凭据
console.log('— 凭据 —');
let config = null;
if (!fs.existsSync(CONFIG_PATH)) {
  bad('缺少 mp.config.json（可 cp mp.config.example.json mp.config.json 后填写）');
} else {
  config = readJson(CONFIG_PATH);
  if (!config) {
    bad('mp.config.json 不是合法 JSON');
  } else {
    ok('mp.config.json 存在且可解析');
  }
}

if (config) {
  const appid = typeof config.appid === 'string' ? config.appid : '';
  if (!appid) {
    bad('mp.config.json 缺少 appid');
  } else {
    const masked = `${appid.slice(0, 4)}***${appid.slice(-4)}`;
    if (!/^wx[0-9a-zA-Z]{10,}$/.test(appid)) {
      warn(`appid 形态不常见（${masked}）：小程序 appid 通常以 wx 开头`);
    } else {
      ok(`appid 形态正常（${masked}）`);
    }
  }

  const keyPath = typeof config.privateKeyPath === 'string' ? config.privateKeyPath : '';
  if (!keyPath) {
    bad('mp.config.json 缺少 privateKeyPath');
  } else {
    const resolved = path.isAbsolute(keyPath) ? keyPath : path.join(ROOT, keyPath);
    if (!fs.existsSync(resolved)) {
      bad(`私钥文件不存在：${path.basename(resolved)}（请确认文件名与大小写）`);
    } else {
      const content = fs.readFileSync(resolved, 'utf8');
      if (content.length < 100) {
        bad('私钥文件内容过短，可能不是有效的密钥文件');
      } else if (!content.includes('PRIVATE KEY')) {
        warn('私钥文件里没有出现 "PRIVATE KEY" 字样，请确认下载的是「代码上传密钥」而非 AppSecret');
      } else {
        ok(`私钥文件可读（${content.length} 字节，未展示内容）`);
      }
    }
  }
}

// ② 项目结构
console.log('\n— 项目结构 —');
const projectConfig = readJson(path.join(ROOT, 'project.config.json'));
if (!projectConfig) {
  bad('project.config.json 缺失或不是合法 JSON');
} else {
  const root = projectConfig.miniprogramRoot ?? '';
  if (!root) {
    bad('project.config.json 缺少 miniprogramRoot');
  } else if (!fs.existsSync(path.join(ROOT, root))) {
    bad(`miniprogramRoot 指向的目录不存在：${root}`);
  } else {
    ok(`miniprogramRoot = ${root}`);
  }
  info(`libVersion = ${projectConfig.libVersion ?? '未设置'}`);
}

const appJsonPath = path.join(ROOT, 'miniprogram', 'app.json');
const appJson = readJson(appJsonPath);
if (!appJson) {
  bad('miniprogram/app.json 缺失或不是合法 JSON');
} else {
  ok(`app.json 可解析（${appJson.pages?.length ?? 0} 个主包页面）`);
  const subPackages = Array.isArray(appJson.subPackages) ? appJson.subPackages : [];
  const spikePack = subPackages.find((item) => item.root === 'spikes');
  if (!spikePack) {
    warn('app.json 里没有 spikes 分包：M0 实验页将无法访问');
  } else {
    ok(`spikes 分包已注册（${spikePack.pages?.length ?? 0} 个页面）`);
  }
  if (appJson.workers !== 'workers') {
    warn(`app.json 的 workers 字段是 ${appJson.workers ?? '未设置'}（本项目为 workers）`);
  } else {
    ok('workers 字段 = workers');
  }
}

const workerEntry = path.join(ROOT, 'miniprogram', 'workers', 'render', 'index.ts');
if (!fs.existsSync(workerEntry)) {
  warn('workers/render/index.ts 不存在：渲染 Worker 无法创建');
} else {
  ok('渲染 Worker 入口存在（workers/render/index.ts）');
}

// ③ 结论
console.log('\n— 结论 —');
if (problems.length === 0) {
  console.log('自检通过：可以执行 npm run mp:preview 生成真机预览二维码。');
  if (warnings.length > 0) console.log(`（有 ${warnings.length} 条提醒，见上方 ! 行）`);
} else {
  console.log(`发现 ${problems.length} 个问题，需先解决：`);
  for (const item of problems) console.log(`  - ${item}`);
  console.log('\n若是"测试号没有代码上传密钥"，则 miniprogram-ci 通道不可用，');
  console.log('需要改用开发者工具（PC）或注册个人主体小程序号后再来。');
  process.exit(1);
}
