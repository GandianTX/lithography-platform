// src/core/local-runtime/policy/local-restore-reason-safety.policy.ts

/**
 * 处置原因（管理员自由文本）的**敏感内容识别**（纯函数层，无 I/O／无框架）。
 *
 * ## 为什么单列一层
 *
 * 管理员在"恢复故障现场受控解冻"里填写的处置原因会**原样进入持久化审计**
 * （`management_audit_event.detail.reason`），并被任务 10 的读侧投影出来。
 * 因此"原因里写了什么"就等于"谁能看到什么"：
 * 凭据、令牌、系统绝对路径一旦写进去，就**持久化**并对**有权查看该事件的人**可见。
 *
 * 既有最小校验（去空白／长度上限／拒绝控制字符）挡不住这类内容：
 * `token=FAKE_EXAMPLE_SECRET /srv/private` 完全符合那三条，却仍是敏感文本。
 *
 * ## 口径：**拒绝输入**，不改写、不脱敏后放行
 *
 * - **拒绝**：不合规的原因**明确拒绝**（不落库、不入日志、不回显命中内容）；
 * - **不改写**：绝不把敏感原因"清洗"成另一段文字后照常落库——
 *   那会让审计里的原因**不再是操作者真正写下的那句话**，等于把原因伪装成不同事实；
 * - **不回显**：校验错误只给"类型级"提示（凭据／令牌 或 系统绝对路径），
 *   绝不把命中的原文带回给调用方、日志或测试报告。
 *
 * ## 剩余风险（**必须如实说明，不得声称"彻底防泄漏"**）
 *
 * 自由文本里的秘密**无法靠有限规则穷尽识别**。本层只覆盖"可明确识别"的两类：
 * 1. **凭据赋值／令牌**：`token=…`、`password: …`、`Bearer …` 等**键值形态**；
 * 2. **系统绝对路径**：Unix（`/srv/private`）、Windows（`C:\Windows\…`）、UNC（`\\host\share`）。
 *
 * 规则之外的形态（例如把密钥拆成两段、用同形字、只写"见附件"）**仍可能漏过**。
 * 因此本层是"**降低**风险"，不是"**杜绝**风险"；真正的边界仍是
 * "处置原因不得承载秘密"这一操作要求与审计可见范围的最小化。
 */

/** 识别出的敏感内容类别（**不含**命中的原文） */
export type LocalRestoreReasonSensitiveKind = 'CREDENTIAL_LIKE' | 'ABSOLUTE_PATH';

/** 识别结果（只带类别，不带原文） */
export type LocalRestoreReasonSensitiveFinding = {
  readonly kind: LocalRestoreReasonSensitiveKind;
};

/**
 * 凭据类关键词（ASCII，大小写不敏感；命中时要求左右不是 ASCII 词字符）。
 *
 * 覆盖任务书与常见运维用语里最容易被当成"值"写进来的键名。
 */
const ASCII_CREDENTIAL_KEYWORDS: ReadonlyArray<string> = [
  'access_key',
  'access_token',
  'accesskey',
  'api_key',
  'api_secret',
  'apikey',
  'app_secret',
  'auth_token',
  'authorization',
  'bearer',
  'client_secret',
  'cookie',
  'credential',
  'credentials',
  'id_token',
  'passphrase',
  'passwd',
  'password',
  'private_key',
  'privatekey',
  'pwd',
  'refresh_token',
  'secret',
  'secret_key',
  'secret_token',
  'secrets',
  'service_key',
  'session_id',
  'sessionid',
  'token',
  'tokens',
];

/** 凭据类关键词（中文；后接分隔符或值时才判定，不做词边界判定） */
const CJK_CREDENTIAL_KEYWORDS: ReadonlyArray<string> = [
  '密码',
  '口令',
  '密钥',
  '秘钥',
  '凭据',
  '令牌',
];

/** 命中"看起来像凭据值"的判定里，允许出现的分隔／混排符号 */
const SECRET_LIKE_SYMBOLS = '_-=+/.~@#$%&*';

/**
 * 识别处置原因里的敏感内容。
 *
 * @param value 待检查的处置原因（调用方应先做去首尾空白；本函数内部也会再规范化一次）
 * @returns 命中时返回**类别**（不含原文）；未命中返回 null
 */
export function detectLocalRestoreReasonSensitiveContent(
  value: string,
): LocalRestoreReasonSensitiveFinding | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (findCredentialLike(trimmed)) {
    return { kind: 'CREDENTIAL_LIKE' };
  }
  if (findAbsolutePath(trimmed)) {
    return { kind: 'ABSOLUTE_PATH' };
  }
  return null;
}

/* ────────────────────────────── 凭据赋值／令牌 ────────────────────────────── */

/**
 * 是否存在"凭据键 → 值"的赋值形态。
 *
 * 两种形态：
 * 1. **键值形态**：`token=值`、`password: 值`、`密码：值` ⇒ 值只要是**非空的可打印 ASCII**
 *    就判定为凭据（中文散文值不算秘密，例如 `令牌：已失效` 不会被误伤）；
 * 2. **相邻形态**：`token 值`（无分隔符）⇒ 值必须**同时**具备"像凭据"的特征
 *    （含数字的字母组合，或含常见混排符号），避免把 `token reset` 这类散文误判。
 */
function findCredentialLike(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    for (const keyword of ASCII_CREDENTIAL_KEYWORDS) {
      if (!matchesAsciiKeyword(value, index, keyword)) {
        continue;
      }
      if (credentialValueAfterKeyword(value, index + keyword.length)) {
        return true;
      }
    }
    for (const keyword of CJK_CREDENTIAL_KEYWORDS) {
      if (!value.startsWith(keyword, index)) {
        continue;
      }
      if (credentialValueAfterKeyword(value, index + keyword.length)) {
        return true;
      }
    }
  }
  return false;
}

/** ASCII 关键词命中（大小写不敏感，且左右不是 ASCII 词字符） */
function matchesAsciiKeyword(value: string, index: number, keyword: string): boolean {
  if (index > 0 && isAsciiWordChar(value[index - 1])) {
    return false;
  }
  const end = index + keyword.length;
  if (end > value.length) {
    return false;
  }
  if (value.slice(index, end).toLowerCase() !== keyword) {
    return false;
  }
  return end >= value.length || !isAsciiWordChar(value[end]);
}

/** 关键词之后的值是否构成"凭据值" */
function credentialValueAfterKeyword(value: string, afterKeyword: number): boolean {
  let cursor = afterKeyword;
  while (cursor < value.length && isSpace(value[cursor])) {
    cursor += 1;
  }
  if (cursor >= value.length) {
    return false;
  }
  const separator = value[cursor];
  if (separator === '=' || separator === ':' || separator === '：') {
    cursor += 1;
    while (cursor < value.length && isSpace(value[cursor])) {
      cursor += 1;
    }
    const assigned = readToken(value, cursor);
    // 键值形态：非空且为可打印 ASCII ⇒ 判定为凭据值
    // （中文散文值不是秘密，例如 `令牌：已失效`）
    return assigned.length > 0 && isPrintableAscii(assigned);
  }
  // 相邻形态：必须是"像凭据"的值，避免 `token reset` 这类散文被误判
  return looksLikeSecretValue(readToken(value, cursor));
}

/** 取到下一个空白为止的记号 */
function readToken(value: string, start: number): string {
  let end = start;
  while (end < value.length && !isSpace(value[end])) {
    end += 1;
  }
  return value.slice(start, end);
}

/**
 * 是否"看起来像凭据值"。
 *
 * 条件：长度 ≥ 4 ＋ 全部为可打印 ASCII ＋ （字母与数字同时出现 或 含常见混排符号）。
 * 这样 `FAKE_EXAMPLE_SECRET`、`Hunter2`、`P@ssw0rd` 命中，而 `reset`、`已失效` 不命中。
 */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < 4 || !isPrintableAscii(value)) {
    return false;
  }
  let hasLetter = false;
  let hasDigit = false;
  let hasSymbol = false;
  for (const char of value) {
    if (isAsciiLetter(char)) {
      hasLetter = true;
    } else if (isAsciiDigit(char)) {
      hasDigit = true;
    }
    if (SECRET_LIKE_SYMBOLS.includes(char)) {
      hasSymbol = true;
    }
  }
  return (hasLetter && hasDigit) || hasSymbol;
}

/* ────────────────────────────── 系统绝对路径 ────────────────────────────── */

/**
 * 是否存在**系统绝对路径**。
 *
 * 覆盖三类：
 * - Unix：`/srv/private`（≥2 段；单段如 `/tmp` 不判，避免误伤散文里的斜杠）；
 * - Windows 盘符：`C:\Windows\System32`、`C:/Users/…`；
 * - UNC：`\\host\share`。
 *
 * 刻意**不**判定的形态：URL（`https://host/path`）与相对路径（`A/srv/private`）——
 * 它们不是"系统绝对路径"，误判会让提示语与事实不符。
 */
function findAbsolutePath(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      if (value[index + 1] === '\\' && index + 2 < value.length) {
        if (index === 0 || !isAsciiWordChar(value[index - 1])) {
          return true;
        }
      }
      continue;
    }
    if (char === '/') {
      if (isUnixAbsolutePath(value, index)) {
        return true;
      }
      continue;
    }
    if (
      isAsciiLetter(char) &&
      value[index + 1] === ':' &&
      (value[index + 2] === '\\' || value[index + 2] === '/') &&
      index + 3 < value.length &&
      (index === 0 || !isAsciiWordChar(value[index - 1]))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `value[index]` 处的 `/` 是否开启一条 Unix 绝对路径。
 *
 * - 起始判定：前一个字符不能是路径字符、`/` 或 `:`（`:` 排除 `https://` 这类 URL）；
 * - 段数判定：至少 2 段（`/srv/private` 命中；`/tmp` 不命中）。
 */
function isUnixAbsolutePath(value: string, index: number): boolean {
  if (index > 0) {
    const previous = value[index - 1];
    if (isPathChar(previous) || previous === '/' || previous === ':') {
      return false;
    }
  }
  let cursor = index + 1;
  let segments = 0;
  while (cursor < value.length) {
    const start = cursor;
    while (cursor < value.length && isPathSegmentChar(value[cursor])) {
      cursor += 1;
    }
    if (cursor === start) {
      break;
    }
    segments += 1;
    if (cursor < value.length && value[cursor] === '/') {
      cursor += 1;
      continue;
    }
    break;
  }
  return segments >= 2;
}

/* ────────────────────────────── 字符判定小工具 ────────────────────────────── */

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isAsciiLetter(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** ASCII 词字符（字母／数字／下划线） */
function isAsciiWordChar(char: string): boolean {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '_';
}

/** 路径字符（路径段内允许的字符） */
function isPathChar(char: string): boolean {
  return isPathSegmentChar(char);
}

function isPathSegmentChar(char: string): boolean {
  return (
    isAsciiLetter(char) ||
    isAsciiDigit(char) ||
    char === '.' ||
    char === '_' ||
    char === '-' ||
    char === '~'
  );
}

/** 是否全部为可打印 ASCII（0x21～0x7E；中文等非 ASCII 字符一律不算） */
function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}
