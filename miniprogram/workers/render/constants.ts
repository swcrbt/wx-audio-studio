/**
 * 产品与性能阈值的集中处（纯逻辑层：Worker 与主线程共用同一份）。
 *
 * 每个常量都注明它的含义与前提；需要改口径时改这里一处。
 */

/** 单个素材的时长上限（秒）：平台录音上限为 10 分钟，导入同样按此上限拒绝。 */
export const MAX_ASSET_DURATION_SEC = 600;

/** 解码产物的内存上限（字节）：音频解码是内存峰值的主要来源，超过则拒绝导入。 */
export const MAX_DECODED_BYTES = 120 * 1024 * 1024;

/** 本地用户文件 + 本地缓存文件的合计配额（字节）：平台硬限制。 */
export const STORAGE_QUOTA_BYTES = 200 * 1024 * 1024;

/** 单文件写入上限（字节）：平台硬限制，超限时平台返回错误码 1300202。 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** 容量警戒比例：达到 warn 时首页提示，达到 critical 时导出前强制提示清理。 */
export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CRITICAL_RATIO = 0.95;

/** 默认渲染块大小（秒）：过大降低进度反馈粒度，过小增加跨线程往返次数。 */
export const DEFAULT_RENDER_CHUNK_SEC = 2;

/** 导入/导出等管线按块处理的大小（秒）：决定内存驻留量。 */
export const PROCESS_CHUNK_SEC = 5;

/** 预览渲染缓存保留份数上限。 */
export const MAX_PREVIEW_FILES = 3;

/** 撤销栈容量上限。 */
export const MAX_HISTORY = 100;

/** 相同合并键的命令合并窗口（毫秒）。 */
export const COALESCE_WINDOW_MS = 800;

/** 时间轴吸附网格（秒）。 */
export const SNAP_GRID_SEC = 0.1;

/** 片段与轨道增益的允许范围（dB）。 */
export const MIN_GAIN_DB = -60;
export const MAX_GAIN_DB = 12;
