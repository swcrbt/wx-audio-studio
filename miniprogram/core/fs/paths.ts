/**
 * 所有文件路径的唯一构造入口（AGENTS §1：禁止在其他地方硬编码 `USER_DATA_PATH`
 * 或任何文件路径字符串）。目录布局与命名规则见 docs/05 §4。
 */
export const DATA_DIRS = {
  assets: 'assets',
  peaks: 'peaks',
  projects: 'projects',
  renders: 'renders',
  tmp: 'tmp',
} as const;

/** 需要保证存在的目录（启动时创建）。 */
export const ALL_DATA_DIRS: readonly string[] = Object.values(DATA_DIRS);

function userDataPath(): string {
  return wx.env.USER_DATA_PATH;
}

export const paths = {
  /** `USER_DATA_PATH` 根目录（需要绝对路径的平台 API 用）。 */
  root(): string {
    return userDataPath();
  },

  /** 相对路径形式（写进工程 JSON / index.json，便于跨设备迁移）。 */
  relative: {
    asset(assetId: string): string {
      return `${DATA_DIRS.assets}/${assetId}.wav`;
    },
    peaks(assetId: string): string {
      return `${DATA_DIRS.peaks}/${assetId}.pk`;
    },
  },

  asset(assetId: string): string {
    return `${userDataPath()}/${DATA_DIRS.assets}/${assetId}.wav`;
  },

  peaks(assetId: string): string {
    return `${userDataPath()}/${DATA_DIRS.peaks}/${assetId}.pk`;
  },

  project(projectId: string): string {
    return `${userDataPath()}/${DATA_DIRS.projects}/${projectId}.json`;
  },

  /** 原子保存的临时文件（写成功后用 rename 覆盖正式文件，docs/05 §7）。 */
  projectTmp(projectId: string): string {
    return `${paths.project(projectId)}.tmp`;
  },

  /** 编辑器预览缓存（可随时删除重建）。 */
  preview(projectId: string): string {
    return `${userDataPath()}/${DATA_DIRS.renders}/preview-${projectId}.wav`;
  },

  /** 用户成品（永不自动删除）。 */
  output(projectId: string, stamp: string): string {
    return `${userDataPath()}/${DATA_DIRS.renders}/out-${projectId}-${stamp}.wav`;
  },

  /** 未完成渲染的续跑状态。 */
  renderState(projectId: string): string {
    return `${userDataPath()}/${DATA_DIRS.tmp}/render-${projectId}.state`;
  },

  tmp(name: string): string {
    return `${userDataPath()}/${DATA_DIRS.tmp}/${name}`;
  },

  index(): string {
    return `${userDataPath()}/index.json`;
  },
};

/**
 * 生成 `{timestamp}-{6位 base36 随机}` 形式的 id（docs/05 §4.2）。
 * 随机后缀用于避免同毫秒创建冲突。
 */
export function createId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return `${now}-${rand}`;
}
