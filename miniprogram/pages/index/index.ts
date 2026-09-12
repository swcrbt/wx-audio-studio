/**
 * 项目列表页：最近工程、新建、导入、存储管理入口。
 *
 * 列表只读 `index.json`（轻量索引），不解析工程文件——这是 docs/05 §4.1 的设计前提。
 * 导入是长任务：进度内联显示（不用全屏遮罩），失败文案带可执行动作。
 */
import type { Id } from '../../core/types';
import { importFileIntoProject, renameProjectById } from '../../core/store/import-file';
import { computeStorageUsage, formatUsageRatio, type StorageUsage } from '../../core/fs/quota';
import { ensureDataDirs, readStoreIndex, removeProjectEntry, type StoreProjectEntry } from '../../core/fs/store';
import { createProject, deleteProjectFile } from '../../core/store/create-project';
import { readSettings } from '../../core/settings';
import { ImportError } from '../../core/audio/import';
import { formatBytes, formatDuration, formatRelativeTime } from '../../utils/format';
import { logger } from '../../utils/logger';

interface ProjectView {
  id: Id;
  name: string;
  durationLabel: string;
  updatedLabel: string;
  sizeLabel: string;
}

interface ImportProgressView {
  name: string;
  stage: string;
  percent: number;
}

const IMPORT_STAGE_TEXT: Record<string, string> = {
  read: '读取文件',
  decode: '解码中',
  process: '转换中',
  peaks: '生成波形',
  done: '完成',
};

interface IndexState {
  projects: ProjectView[];
  usageText: string;
  usageLevel: string;
  resumeProject: { id: Id; name: string } | null;
  importing: ImportProgressView | null;
}

const states = new WeakMap<object, IndexState>();

function stateOf(instance: object): IndexState {
  let state = states.get(instance);
  if (!state) {
    state = { projects: [], usageText: '', usageLevel: 'ok', resumeProject: null, importing: null };
    states.set(instance, state);
  }
  return state;
}

Page({
  data: {
    projects: [] as ProjectView[],
    usageText: '',
    usageLevel: 'ok',
    resumeProject: null as { id: Id; name: string } | null,
    importing: null as ImportProgressView | null,
    emptyActions: [
      { key: 'record', label: '开始录音', primary: true },
      { key: 'import', label: '导入文件', primary: false },
    ],
  },

  async onShow() {
    await refresh(this);
  },

  async handleCreate() {
    const name = await promptProjectName(this, '新建工程');
    if (name === null) return;
    try {
      const project = await createProject({ name, withDefaultTrack: true });
      wx.navigateTo({ url: `/pages/editor/editor?projectId=${project.id}` });
    } catch (error) {
      logger.warn('index', 'create project failed', error);
      wx.showToast({ title: '新建失败，请检查存储空间', icon: 'none' });
    }
  },

  handleGoRecord() {
    wx.switchTab({ url: '/pages/record/record' });
  },

  /** 从聊天记录选择音频文件导入（M1 唯一的外部素材来源，隐私上全端上处理）。 */
  handleImportFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['wav', 'mp3', 'm4a', 'aac', 'amr'],
      success: (res) => {
        const file = res.tempFiles[0];
        if (!file) return;
        const name = (file.name ?? '导入音频').replace(/\.[^.]+$/, '');
        void runImport(this, file.path, name);
      },
      fail: (error) => {
        // 用户主动取消不打扰
        if (String((error as { errMsg?: string }).errMsg ?? '').includes('cancel')) return;
        wx.showToast({ title: '选择文件失败', icon: 'none' });
      },
    });
  },

  handleOpen(event: WechatMiniprogram.TouchEvent) {
    const id = readId(event);
    if (!id) return;
    wx.navigateTo({ url: `/pages/editor/editor?projectId=${id}` });
  },

  handleOpenResume() {
    const state = stateOf(this);
    if (!state.resumeProject) return;
    wx.navigateTo({ url: `/pages/editor/editor?projectId=${state.resumeProject.id}` });
  },

  handleEmptyAction(event: WechatMiniprogram.CustomEvent) {
    const key = (event.detail as { key?: string }).key;
    if (key === 'record') this.handleGoRecord();
    else if (key === 'import') this.handleImportFile();
  },

  handleCardMenu(event: WechatMiniprogram.TouchEvent) {
    const id = readId(event);
    if (!id) return;
    const project = stateOf(this).projects.find((item) => item.id === id);
    if (!project) return;

    wx.showActionSheet({
      itemList: ['重命名', '导出', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) void renameProject(this, project);
        else if (res.tapIndex === 1) wx.navigateTo({ url: `/pages/export/export?projectId=${id}` });
        else if (res.tapIndex === 2) void deleteProject(this, project);
      },
      fail: () => undefined,
    });
  },

  async handleCleanup() {
    const usage = await computeStorageUsage();
    const keptText = `素材 ${formatBytes(usage.assetsBytes)} · 波形 ${formatBytes(
      usage.peaksBytes,
    )} · 成品 ${formatBytes(usage.rendersBytes)} · 临时 ${formatBytes(usage.tmpBytes)}`;

    wx.showModal({
      title: '存储占用明细',
      content: `${keptText}\n\n可清理：临时文件与未被引用的预览缓存。`,
      confirmText: '立即清理',
      success: async (res) => {
        if (!res.confirm) return;
        const { cleanStalePreviews, clearTmpDir } = await import('../../core/fs/quota');
        const [tmpBytes, previews] = await Promise.all([clearTmpDir(), cleanStalePreviews()]);
        wx.showToast({
          title: `已清理 ${formatBytes(tmpBytes)}${previews > 0 ? ` 与 ${previews} 个预览` : ''}`,
          icon: 'none',
        });
        await refresh(this);
      },
    });
  },
});

function readId(event: WechatMiniprogram.TouchEvent): Id | null {
  const id = (event.currentTarget.dataset as { id?: string }).id;
  return id ?? null;
}

async function promptProjectName(
  _page: WechatMiniprogram.Page.TrivialInstance,
  title: string,
  defaultValue = '',
): Promise<string | null> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      editable: true,
      placeholderText: '工程名称',
      ...(defaultValue ? { content: defaultValue } : {}),
      success: (res) => resolve(res.confirm ? (res.content ?? '').trim() || '未命名工程' : null),
      fail: () => resolve(null),
    });
  });
}

async function renameProject(
  page: WechatMiniprogram.Page.TrivialInstance,
  project: ProjectView,
): Promise<void> {
  const name = await promptProjectName(page, '重命名', project.name);
  if (name === null) return;
  try {
    await renameProjectById(project.id, name);
    await refresh(page);
  } catch (error) {
    logger.warn('index', 'rename failed', error);
    wx.showToast({ title: '重命名失败', icon: 'none' });
  }
}

async function deleteProject(
  page: WechatMiniprogram.Page.TrivialInstance,
  project: ProjectView,
): Promise<void> {
  const confirmed = await new Promise<boolean>((resolve) => {
    wx.showModal({
      title: '删除工程',
      content: `确定删除「${project.name}」？素材文件会保留在"清理未引用素材"里可恢复。`,
      confirmText: '删除',
      confirmColor: '#cf1322',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;

  await deleteProjectFile(project.id);
  try {
    const index = await readStoreIndex();
    await removeProjectEntry(index, project.id);
  } catch (error) {
    logger.warn('index', 'remove index entry failed', error);
  }
  await refresh(page);
  wx.showToast({ title: '已删除', icon: 'none' });
}

/** 导入流程：建工程 → 导入素材 → 挂到时间轴 → 进编辑器。 */
async function runImport(
  page: WechatMiniprogram.Page.TrivialInstance,
  srcPath: string,
  name: string,
): Promise<void> {
  const state = stateOf(page);
  state.importing = { name, stage: IMPORT_STAGE_TEXT.read ?? '', percent: 0 };
  page.setData({ importing: state.importing });

  try {
    const project = await createProject({
      name,
      withDefaultTrack: true,
      // 工程采样率来自偏好：它决定素材中间格式，打开后不可更改
      sampleRate: readSettings().defaultSampleRate,
    });
    await importFileIntoProject({ project, srcPath, onProgress: (stage, ratio) => {
      state.importing = {
        name,
        stage: IMPORT_STAGE_TEXT[stage] ?? stage,
        percent: Math.round(ratio * 100),
      };
      page.setData({ importing: state.importing });
    } });

    state.importing = null;
    page.setData({ importing: null });
    wx.navigateTo({ url: `/pages/editor/editor?projectId=${project.id}` });
    await refresh(page);
  } catch (error) {
    state.importing = null;
    page.setData({ importing: null });
    const message = error instanceof ImportError ? error.message : '导入失败，请重试';
    logger.warn('index', 'import failed', error);
    wx.showModal({ title: '导入失败', content: message, showCancel: false });
  }
}

async function refresh(page: WechatMiniprogram.Page.TrivialInstance): Promise<void> {
  const state = stateOf(page);
  await ensureDataDirs();

  const index = await readStoreIndex();
  const projects = index.projects
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toView);

  const resumeEntry = index.lastOpenedProjectId
    ? index.projects.find((item) => item.id === index.lastOpenedProjectId)
    : undefined;

  let usage: StorageUsage | null = null;
  try {
    usage = await computeStorageUsage();
  } catch (error) {
    logger.warn('index', 'storage usage failed', error);
  }

  state.projects = projects;
  state.resumeProject = resumeEntry ? { id: resumeEntry.id, name: resumeEntry.name } : null;
  state.usageText = usage ? formatUsageRatio(usage) : '—';
  state.usageLevel = usage?.level ?? 'ok';

  page.setData({
    projects,
    resumeProject: state.resumeProject,
    usageText: state.usageText,
    usageLevel: state.usageLevel,
  });
}

function toView(entry: StoreProjectEntry): ProjectView {
  return {
    id: entry.id,
    name: entry.name,
    durationLabel: entry.durationSec > 0 ? formatDuration(entry.durationSec) : '空工程',
    updatedLabel: formatRelativeTime(entry.updatedAt),
    sizeLabel: entry.sizeBytes > 0 ? formatBytes(entry.sizeBytes) : '—',
  };
}

export {};