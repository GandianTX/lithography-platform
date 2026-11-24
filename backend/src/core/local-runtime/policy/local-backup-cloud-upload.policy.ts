// src/core/local-runtime/policy/local-backup-cloud-upload.policy.ts
/**
 * 云备份上云的**纯裁决**（任务 09 第 10 项 D3／D5）。
 *
 * 为什么要有这一层：
 * - 此前上传链对"本机包"与"云端"两类失败**不做区分**：本机包读不到、清单与包内
 *   字节对不上，都被压成 `CLOUD_UNREACHABLE`（"云端不可达"）。这会把**本机侧的事实问题**
 *   误报成**远端故障**，排障方向直接被带偏；更严重的是"清单说有原件、包里读不到"
 *   会被静默成"零原件但上传成功"——云端拿到的是一份缺原件的包，却收到成功回执。
 * - 大小纪律此前完全缺失：备份包要**整读进内存**再以 multipart 部件送出，
 *   没有上限就等于"一个超大包把 Worker 内存吃光"（进程崩溃比一次失败更糟）。
 *
 * 本模块只做**纯函数裁决**（输入事实 → 受控结论），不碰文件系统与网络：
 * - 文件系统事实由 infrastructure 层采集后传入；
 * - 受控失败码与其它云链共用同一形态（大写下划线），落库前过受控形态校验。
 */

import { isCompleteCloudReceipt } from './local-backup-cloud-receipt.policy';

/**
 * **远端（云端）失败码**——HTTP 客户端能产出的全部失败码。
 *
 * 单一来源：客户端只产出这 6 个码（此前客户端自己又写了一份同值常量，
 * 与本模块的 9 个码是两套互不相通的类型 ⇒ 客户端返回值无法类型安全地
 * 喂给 `decideCloudUploadFailureDisposition`）。
 */
export const CLOUD_REMOTE_FAILURE_CODES = {
  /** 云服务未接入（地址或凭据缺失） */
  CLOUD_NOT_CONFIGURED: 'CLOUD_NOT_CONFIGURED',
  /** 云端不可达 */
  CLOUD_UNREACHABLE: 'CLOUD_UNREACHABLE',
  /** 云端请求超时 */
  CLOUD_TIMEOUT: 'CLOUD_TIMEOUT',
  /** 云端拒绝（4xx） */
  CLOUD_REJECTED: 'CLOUD_REJECTED',
  /** 云端异常（5xx） */
  CLOUD_SERVER_ERROR: 'CLOUD_SERVER_ERROR',
  /** 云端回包形态非法（缺引用／缺回执／回执不完整） */
  CLOUD_INVALID_RESPONSE: 'CLOUD_INVALID_RESPONSE',
} as const;

export type CloudRemoteFailureCode =
  (typeof CLOUD_REMOTE_FAILURE_CODES)[keyof typeof CLOUD_REMOTE_FAILURE_CODES];

/** 上传链的受控失败码（远端 6 个 ＋ 本机包结构性 3 个） */
export const CLOUD_UPLOAD_FAILURE_CODES = {
  ...CLOUD_REMOTE_FAILURE_CODES,
  /** 本机包不可读（清单缺失／不可解析／摘要不符／原件目录读不到） */
  CLOUD_PACKAGE_UNREADABLE: 'CLOUD_PACKAGE_UNREADABLE',
  /** 本机包与清单不一致（缺件／大小不符／摘要不符／协议不覆盖的文件） */
  CLOUD_PACKAGE_INCOMPLETE: 'CLOUD_PACKAGE_INCOMPLETE',
  /** 本机包超出上传大小上限 */
  CLOUD_PACKAGE_TOO_LARGE: 'CLOUD_PACKAGE_TOO_LARGE',
} as const;

export type CloudUploadFailureCode =
  (typeof CLOUD_UPLOAD_FAILURE_CODES)[keyof typeof CLOUD_UPLOAD_FAILURE_CODES];

/** 单个包内文件的大小事实 */
export type CloudUploadFileSize = {
  /** 包内相对路径（如 `payload.enc` / `files/xxx.pdf`） */
  relativePath: string;
  byteSize: number;
};

/**
 * 单个包内文件的内容事实（相对路径 ＋ 字节数 ＋ 实测摘要）。
 *
 * 相对路径用**包内相对路径**（与清单 `files[].relative_path` 同口径），
 * 便于"清单 ↔ 字节"逐项一一对应。
 */
export type CloudUploadFileFact = CloudUploadFileSize & {
  /** 实测 SHA-256（十六进制小写） */
  sha256: string;
};

/** 大小上限裁决结果 */
export type CloudUploadSizeVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'CLOUD_PACKAGE_TOO_LARGE'; readonly detail: string };

/**
 * 大小上限裁决（**在读取字节之前**判定）。
 *
 * 为什么要先判后读：上传链要把整包读进内存再组 multipart，
 * 读完之后才发现超限，内存峰值已经付出去了——上限就失去了意义。
 *
 * 口径：
 * - 单文件上限与单包总量上限**各自**判定，任一超限即拒绝；
 * - 总量按"清单登记的全部文件"累加（清单是包的权威内容清单）。
 */
export function decideCloudUploadSizeLimit(input: {
  files: readonly CloudUploadFileSize[];
  maxFileBytes: number;
  maxPackageBytes: number;
}): CloudUploadSizeVerdict {
  let totalBytes = 0;
  let overflowed = false;
  for (const file of input.files) {
    if (file.byteSize > input.maxFileBytes) {
      return {
        allowed: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
        detail: `单个文件超出上限（${file.relativePath}）`,
      };
    }
    // 饱和累加：清单里的字节数没有上限（只校验了非负整数），
    // 恶意／损坏清单声明 9e15 会让累加变成不精确浮点。
    // 溢出后**结论不翻转**：真实总量已超过 2^53，任何现实上限都判超限。
    const next = totalBytes + file.byteSize;
    if (!Number.isSafeInteger(next)) {
      overflowed = true;
      totalBytes = Number.MAX_SAFE_INTEGER;
    } else {
      totalBytes = next;
    }
  }
  const exceedsLimit = overflowed
    ? input.maxPackageBytes <= Number.MAX_SAFE_INTEGER
    : totalBytes > input.maxPackageBytes;
  if (exceedsLimit) {
    return {
      allowed: false,
      code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
      detail: '备份包总量超出上限',
    };
  }
  return { allowed: true };
}

/** 清单 ↔ 字节一致性裁决结果 */
export type CloudUploadConsistencyVerdict =
  | { readonly consistent: true }
  | {
      readonly consistent: false;
      readonly code: 'CLOUD_PACKAGE_INCOMPLETE';
      /** 清单登记但包内缺失的文件 */
      readonly missing: readonly string[];
      /** 包内存在但与清单登记不一致的文件（大小或摘要不符） */
      readonly mismatched: readonly string[];
    };

/**
 * 清单 ↔ 包内字节的**逐项一致性**裁决。
 *
 * 这是 D5 的核心闸门：清单是包的权威内容清单，"清单说有、包里没有（或不是同一份）"
 * 绝不能被当作"上传成功"——云端会收到一份缺件或串件的包，却拿到成功回执。
 *
 * 口径：
 * - 清单登记的每个文件都必须在包内存在，且**字节数与摘要逐项一致**；
 * - 包内存在但清单未登记的文件**不算失败**（生成侧复制失败会留下半截文件），
 *   但它们**不得被上传**——只发清单登记的内容。
 */
export function decideCloudUploadPackageConsistency(input: {
  declared: readonly CloudUploadFileFact[];
  actual: readonly CloudUploadFileFact[];
}): CloudUploadConsistencyVerdict {
  const actualByPath = new Map(input.actual.map((file) => [file.relativePath, file]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const file of input.declared) {
    const found = actualByPath.get(file.relativePath);
    if (found === undefined) {
      missing.push(file.relativePath);
      continue;
    }
    if (found.byteSize !== file.byteSize || found.sha256 !== file.sha256) {
      mismatched.push(file.relativePath);
    }
  }
  if (missing.length > 0 || mismatched.length > 0) {
    return {
      consistent: false,
      code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
      missing,
      mismatched,
    };
  }
  return { consistent: true };
}

/**
 * 上传**成功**判定：云端引用 ＋ 完整回执，缺一不可。
 *
 * 为什么必须与"清理授权"同口径：手动清理的授权来自
 * `isCompleteCloudReceipt`（可解析为 JSON ＋ 明确成功语义）。
 * 若上传成功只要"回执非空"，就会出现"资产显示已上云，但手动清理恒为零"的
 * 口径分裂——两处对"成功"的定义必须一致。
 *
 * 口径的**唯一实现**：`isCompleteCloudReceipt`（`local-backup-cloud-receipt.policy`）。
 * 此前本函数把"回执是否完整"当形参由调用方注入（`receiptComplete`），
 * 等于允许调用方各判一次 ⇒ 同一口径两处实现；且 `receipt` 形参从未被使用。
 */
export function decideCloudUploadSuccess(input: {
  cloudReference: string | null;
  /** 云端回执原文（可能为空、非 JSON、或带失败语义） */
  receipt: string | null;
}):
  | { readonly succeeded: true }
  | { readonly succeeded: false; readonly code: 'CLOUD_INVALID_RESPONSE' } {
  if (input.cloudReference === null || input.cloudReference.length === 0) {
    return { succeeded: false, code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE };
  }
  if (!isCompleteCloudReceipt(input.receipt).complete) {
    return { succeeded: false, code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE };
  }
  return { succeeded: true };
}

/**
 * **本机包结构性失败**（任务 09 第 10 项 L2）。
 *
 * 这三类失败的判定依据**全部来自本机自己的事实**（清单缺失／不可解析／摘要不符／
 * 清单与字节对不上／超出大小上限），与云端如何响应无关：
 * 备份包一旦生成就是**不可变**的，同一个包重试多少次都会得到同一个结果。
 * 因此它们是**终态**——继续重试只会让同一份无效包按退避周期无限重试，
 * 既烧资源又永远不收敛（且真实原因会被"上传失败"这类通用码掩盖，运维无从下手）。
 */
export const CLOUD_UPLOAD_TERMINAL_FAILURE_CODES = [
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_UNREADABLE,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
] as const;

/**
 * 远端失败码的处置**暂定可重试**（不臆造生产协议）。
 *
 * `CLOUD_REJECTED`（4xx）与 `CLOUD_INVALID_RESPONSE`（回包形态非法）到底是终态还是可重试，
 * 取决于**生产接收端**的真实语义：4xx 可能是"包被判定不合规"（终态），
 * 也可能是"配额已满，稍后重试"（可重试）。在生产协议（G4／G5）落地前无法判定，
 * 因此本仓**保守按可重试**处理，并在生产联调时按云端事实调整。
 * （业务同步链按 4xx 终态处理，是该链已冻结的口径；两链的差异待联调时统一。）
 */
export const CLOUD_UPLOAD_RETRYABLE_FAILURE_CODES = [
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_NOT_CONFIGURED,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_UNREACHABLE,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_TIMEOUT,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_SERVER_ERROR,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_REJECTED,
  CLOUD_UPLOAD_FAILURE_CODES.CLOUD_INVALID_RESPONSE,
] as const;

/** 上传失败处置类别 */
export type CloudUploadFailureDisposition = 'RETRYABLE' | 'TERMINAL';

/**
 * 上传失败的处置裁决（纯函数）。
 *
 * - **未知码按可重试**处理：网络类瞬时故障占多数；绝不因此伪造成功。
 * - 终态仅限**本机包结构性失败**（见 `CLOUD_UPLOAD_TERMINAL_FAILURE_CODES`）。
 */
export function decideCloudUploadFailureDisposition(code: unknown): CloudUploadFailureDisposition {
  if (typeof code !== 'string') {
    return 'RETRYABLE';
  }
  return (CLOUD_UPLOAD_TERMINAL_FAILURE_CODES as readonly string[]).includes(code)
    ? 'TERMINAL'
    : 'RETRYABLE';
}

/** 是否是终态失败（本机包结构性失败） */
export function isTerminalCloudUploadFailure(code: unknown): boolean {
  return decideCloudUploadFailureDisposition(code) === 'TERMINAL';
}
