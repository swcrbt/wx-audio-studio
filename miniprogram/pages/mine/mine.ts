/**
 * 我的：成品列表、存储占用与清理、设置与隐私入口。
 *
 * 这一页是导出页承诺的落地点（"已保存在「我的 → 成品」"）：小程序不能把音频写进
 * 手机文件管理器（docs/02 §1.4），所以成品列表 + 发送给朋友就是用户唯一的分发路径。
 *
 * 成品文件**永不自动删除**：删除只发生在用户明确操作时（docs/05 §5）。
 */
import type { RenderFileInfo } from '../../core/fs/renders';
import { deleteRenderFile, listRenderFiles } from '../../core/fs/renders';
import {
  cleanStalePreviews,
  clearTmpDir,
  computeStorageUsage,
  findUnreferencedAssets,
  formatUsageRatio,
  type StorageUsage,
} from '../../core/fs/quota';
import { readStoreIndex } from '../../core/fs/store';
import { readProject } from '../../core/store/load-project';
import { referencedAssetIds } from '../../workers/render/edl/query';
import { formatBytes, formatDuration, formatRelativeTime } from '../../utils/format';
import { logger } from '../../utils/logger';

interface RenderView {
  fileName: string;
  title: string;
  durationLabel: string;
  sizeLabel: string;
  timeLabel: string;
}

const LEVEL_TEXT: Record<StorageUsage['level'], string> = {
  ok: '正常',
  warn: '接近上限',
  critical: '空间不足',
};

interface MineState {
  files: RenderFileInfo[];
}

const states = new WeakMap<object, MineState>();

function stateOf(instance: object): MineState {
  let state = states.get(instance);
  if (!state) {
    state = { files: [] };
    states.set(instance, state);
  }
  return state;
}

Page({
  data: {
    renders: [] as RenderView[],
    usageText: '—',
    usageLevel: 'ok',
    usageLevelText: '正常',
    usageDetail: '',
    emptyActions: [{ key: 'record', label: '开始录音', primary: true }],
  },

  async onShow() {
    await refresh(this);
  },

  handleEmptyAction() {
    wx.switchTab({ url: '/pages/record/record' });
  },

  handleFileMenu(event: WechatMiniprogram.TouchEvent) {
    const fileName = (event.currentTarget.dataset as { name?: string }).name;
    if (!fileName) return;

    wx.showActionSheet({
      itemList: ['发送给朋友', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) shareFile(fileName, stateOf(this).files);
        else if (res.tapIndex === 1) void removeFile(this, fileName);
      },
      fail: () => undefined,
    });
  },

  async handleCleanTmp() {
    const bytes = await clearTmpDir();
    wx.showToast({ title: bytes > 0 ? `已清理 ${formatBytes(bytes)}` : '没有可清理的临时文件', icon: 'none' });
    await refresh(this);
  },

  async handleCleanUnreferenced() {
    const index = await readStoreIndex();
    const referenced = new Set<string>();
    const allAssets: Array<{ id: string; path: string }> = [];

    // 扫描所有工程：只有"没有任何工程引用"的素材才能删
    for (const entry of index.projects) {
      const project = await readProject(entry.id);
      if (!project) continue;
      const ids = referencedAssetIds({
        sampleRate: project.sampleRate,
        channels: project.channels,
        assets: project.assets,
        tracks: project.tracks,
      });
      for (const id of ids) referenced.add(id);
      for (const asset of project.assets) allAssets.push({ id: asset.id, path: asset.path });
    }

    const orphans = await findUnreferencedAssets(referenced, allAssets);
    if (orphans.length === 0) {
      wx.showToast({ title: '没有未引用的素材', icon: 'none' });
      return;
    }

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '清理未引用素材',
        content: `将删除 ${orphans.length} 个没有被任何工程引用的素材与波形文件，删除后无法恢复。`,
        confirmText: '删除',
        confirmColor: '#cf1322',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    const fs = wx.getFileSystemManager();
    let removed = 0;
    for (const asset of orphans) {
      await unlinkQuiet(fs, `${wx.env.USER_DATA_PATH}/${asset.path}`);
      await unlinkQuiet(fs, `${wx.env.USER_DATA_PATH}/peaks/${asset.id}.pk`);
      removed++;
    }
    void cleanStalePreviews();
    wx.showToast({ title: `已清理 ${removed} 个素材`, icon: 'none' });
    await refresh(this);
  },

  handleOpenSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  handleShowPrivacy() {
    wx.showModal({
      title: '隐私与麦克风用途',
      content:
        '音频只在这台手机上处理与保存，不会上传到任何服务器。麦克风仅在你主动录音时使用，用于录制你的声音。所有剪辑与导出都在本机完成。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  handleShowAbout() {
    wx.showModal({
      title: '关于',
      content: '微信音频工作室 · 录音、剪辑、拼接、导出全部在本机完成。\n\n第三方组件：若无 MP3 导出需求则不引入任何音频编码库。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});

function unlinkQuiet(fs: WechatMiniprogram.FileSystemManager, filePath: string): Promise<void> {
  return new Promise((resolve) => {
    fs.unlink({ filePath, success: () => resolve(), fail: () => resolve() });
  });
}

async function refresh(page: WechatMiniprogram.Page.TrivialInstance): Promise<void> {
  const state = stateOf(page);

  let files: RenderFileInfo[] = [];
  try {
    files = await listRenderFiles();
  } catch (error) {
    logger.warn('mine', 'list renders failed', error);
  }
  state.files = files;

  let usage: StorageUsage | null = null;
  try {
    usage = await computeStorageUsage();
  } catch (error) {
    logger.warn('mine', 'storage usage failed', error);
  }

  page.setData({
    renders: files.map((file) => ({
      fileName: file.fileName,
      title: file.fileName.replace(/\.wav$/, ''),
      durationLabel: file.durationSec > 0 ? formatDuration(file.durationSec) : '读取失败',
      sizeLabel: formatBytes(file.bytes),
      timeLabel: file.createdAt > 0 ? formatRelativeTime(file.createdAt) : '未知时间',
    })),
    usageText: usage ? formatUsageRatio(usage) : '—',
    usageLevel: usage?.level ?? 'ok',
    usageLevelText: usage ? LEVEL_TEXT[usage.level] : '未知',
    usageDetail: usage
      ? `素材 ${formatBytes(usage.assetsBytes)} · 波形 ${formatBytes(usage.peaksBytes)} · 成品 ${formatBytes(
          usage.rendersBytes,
        )} · 工程 ${formatBytes(usage.projectsBytes)} · 临时 ${formatBytes(usage.tmpBytes)}`
      : '',
  });
}

function shareFile(fileName: string, files: RenderFileInfo[]): void {
  const file = files.find((item) => item.fileName === fileName);
  if (!file) return;

  wx.shareFileMessage({
    filePath: file.filePath,
    fileName: file.fileName.replace(/^out-/, ''),
    success: () => undefined,
    fail: (error) => {
      if (String((error as { errMsg?: string }).errMsg ?? '').includes('cancel')) return;
      logger.warn('mine', 'share failed', error);
      wx.showToast({ title: '分享失败，请重试', icon: 'none' });
    },
  });
}

async function removeFile(page: WechatMiniprogram.Page.TrivialInstance, fileName: string): Promise<void> {
  const confirmed = await new Promise<boolean>((resolve) => {
    wx.showModal({
      title: '删除成品',
      content: '删除后无法恢复，确定继续？',
      confirmText: '删除',
      confirmColor: '#cf1322',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;

  try {
    await deleteRenderFile(fileName);
    await refresh(page);
    wx.showToast({ title: '已删除', icon: 'none' });
  } catch (error) {
    logger.warn('mine', 'delete render failed', error);
    wx.showToast({ title: '删除失败，请重试', icon: 'none' });
  }
}
