/**
 * 文件系统错误的可控文案：每个失败路径都要给用户可读文案与可执行动作，
 * 平台错误码必须翻译，不能只提示“操作失败”。
 *
 * 分支里的错误码数值来自微信官方错误码表。
 */
export type FsErrorCode = 'storageFull' | 'noSpace' | 'notFound' | 'permission' | 'ioError' | 'unknown';

export interface FsErrorInfo {
  code: FsErrorCode;
  /** 面向用户的文案。 */
  message: string;
  /** 建议动作（UI 提供对应按钮）。 */
  action: 'cleanup' | 'retry' | 'chooseFile' | 'none';
  /** 原始错误码（用于日志，不含文件路径等可识别信息）。 */
  rawCode?: number;
}

/** 平台错误对象的最小形状（wx 的 fail 回调）。 */
interface PlatformError {
  errMsg?: string;
  errno?: number;
}

const REPAIR_MAX_BYTES = 100 * 1024 * 1024; // 官方：单文件上限 100MB（1300202）

/**
 * 把 `FileSystemManager` 的失败对象翻译成用户可读信息。
 *
 * `1300202` 同时表示"存储空间不足"与"文件大小超出上限"，因此结合待写字节数判断。
 */
export function describeFsError(error: unknown, pendingBytes = 0): FsErrorInfo {
  const platform = (typeof error === 'object' && error !== null ? error : {}) as PlatformError;
  const rawCode = typeof platform.errno === 'number' ? platform.errno : undefined;
  const errMsg = platform.errMsg ?? '';

  if (rawCode === 1300202) {
    if (pendingBytes > REPAIR_MAX_BYTES) {
      return {
        code: 'storageFull',
        message: '导出文件超过单个文件 100MB 上限，请降低采样率、转单声道或缩短时长',
        action: 'none',
        ...(rawCode === undefined ? {} : { rawCode }),
      };
    }
    return {
      code: 'noSpace',
      message: '存储空间不足，请先清理未使用的素材与旧成品',
      action: 'cleanup',
      ...(rawCode === undefined ? {} : { rawCode }),
    };
  }

  if (rawCode === 1300002) {
    return {
      code: 'notFound',
      message: '文件不存在或已被清理，请重新导入该音频',
      action: 'chooseFile',
      ...(rawCode === undefined ? {} : { rawCode }),
    };
  }

  if (rawCode === 1300013 || rawCode === 1300014 || rawCode === 1301000 || rawCode === 1302001) {
    return {
      code: 'permission',
      message: '没有文件读写权限，请重启小程序后重试',
      action: 'retry',
      ...(rawCode === undefined ? {} : { rawCode }),
    };
  }

  if (rawCode === 1300005 || rawCode === 1300201) {
    return {
      code: 'ioError',
      message: '文件读写失败，请重试；若持续失败可重启微信',
      action: 'retry',
      ...(rawCode === undefined ? {} : { rawCode }),
    };
  }

  return {
    code: 'unknown',
    message: errMsg ? '文件操作失败，请重试' : '文件操作失败，请重试',
    action: 'retry',
    ...(rawCode === undefined ? {} : { rawCode }),
  };
}

/** 用户可读的错误包装（保留原始码，但不携带文件路径，符合隐私红线）。 */
export class FsError extends Error {
  readonly info: FsErrorInfo;

  constructor(info: FsErrorInfo) {
    super(info.message);
    this.name = 'FsError';
    this.info = info;
  }
}
