// e2e-real/credential-evidence-policy.ts

/**
 * 含一次性凭据的 Playwright 规格的证据策略（公司开通 / 二级管理员补发 / 普通用户重置）。
 *
 * 这类规格会在断言里直接持有服务端返回的一次性口令（用于对照旧口令失效、核对弹窗内容），
 * 任何自动证据都可能把口令落盘：失败时 trace 含 network + snapshot，video/screenshot 含弹窗明文，
 * reporter 附件同理。因此：
 *
 * - 三个自动证据开关一律固定关闭（`off`），证据只允许由用例显式 `page.screenshot()` 产出，
 *   且显式截图必须发生在凭据出现之前或用例自行承担脱敏责任；
 * - CLI 覆盖同样拒绝：`--trace / --video / --screenshot / --reporter` 会让配置里的 `off`
 *   失效（reporter 可能附带附件），在配置加载期直接硬失败，避免「临时打开看看」。
 *
 * 失败时的诊断依赖断言文本与 `list` reporter 的控制台输出，不依赖任何附件。
 */
export const CREDENTIAL_SAFE_USE = {
  screenshot: 'off',
  trace: 'off',
  video: 'off',
} as const;

/** CLI 上能够重新打开自动证据或追加附件的开关 */
export const CREDENTIAL_ARTIFACT_FLAGS = [
  '--trace',
  '--video',
  '--screenshot',
  '--reporter',
] as const;

/**
 * 在配置加载期校验命令行：命中任一证据开关即硬失败。
 * 同时兼容 `--flag value`（Playwright 风格）与 `--flag=value` 两种写法。
 */
export function assertNoArtifactOverrides(argv: readonly string[] = process.argv): void {
  const offending = argv.filter((argument) => {
    const flag = argument.split('=')[0]?.trim();

    return CREDENTIAL_ARTIFACT_FLAGS.some((forbidden) => flag === forbidden);
  });

  if (offending.length > 0) {
    throw new Error(
      `含凭据的真实联调拒绝覆盖证据开关：检测到 ${offending.join('、')}；` +
        '这些规格会持有一次性口令，trace / video / screenshot / reporter 固定为最保守配置，' +
        '请移除该参数后重试',
    );
  }
}

/** 当前安装实现用于跳过失败页面 ARIA 快照的私有控制变量 */
export const CREDENTIAL_ARTIFACT_ISOLATION_ENV = 'PLAYWRIGHT_NO_COPY_PROMPT';

/**
 * 在凭据专用配置加载期主动打开失败附件隔离。
 *
 * 安装的 Playwright 1.62.1 在测试失败时会把页面 ARIA 快照写入 `error-context.md`
 * （`node_modules/playwright/lib/index.js` 的 `_takePageSnapshot` / `didFinishTest`），
 * 这条路径不受 screenshot / trace / video 开关控制，readonly 口令框同样会被收录。
 * 当前实现的 `_takePageSnapshot` 在 `PLAYWRIGHT_NO_COPY_PROMPT` 为真时直接返回，
 * 因此必须在配置加载期写入该变量，让 runner 与其派生的 worker 进程一起继承。
 *
 * 注意：这是安装实现的私有控制点，不是公开 API；升级 Playwright 后必须用
 * `verify:credential-artifact-isolation` 的真实失败探针重新确认，不能假定长期有效。
 */
export function enableCredentialArtifactIsolation(env: NodeJS.ProcessEnv = process.env): void {
  env[CREDENTIAL_ARTIFACT_ISOLATION_ENV] = '1';
}
