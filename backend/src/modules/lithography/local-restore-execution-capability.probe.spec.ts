// src/modules/lithography/local-restore-execution-capability.probe.spec.ts
/**
 * 恢复执行能力探测的定向测试（review 遗留 L1）。
 *
 * 守住三条：探测只回答**环境级**事实；任一事实取不到即按「未就绪」处理；
 * 三项全就绪才报可用（裁决在 core，不在本文件）。
 */
import { LocalRestoreExecutionCapabilityProbe } from './local-restore-execution-capability.probe';

const KEY_HEX = 'a'.repeat(64);

function buildProbe(options: {
  installation?: { installationId: string } | null;
  writer?: unknown;
  protection?: { keyHex: string; keyId: string } | null;
  failQuery?: boolean;
}) {
  const installationRepository = {
    findOne: jest.fn().mockImplementation(() => {
      if (options.failQuery === true) {
        return Promise.reject(new Error('db down'));
      }
      return Promise.resolve(options.installation ?? null);
    }),
  };
  const probe = new LocalRestoreExecutionCapabilityProbe(
    installationRepository as never,
    options.writer as never,
    options.protection,
  );
  return { probe, installationRepository };
}

describe('恢复执行能力探测', () => {
  it('三项环境事实齐备 ⇒ 三项都就绪', async () => {
    const { probe } = buildProbe({
      installation: { installationId: 'inst-1' },
      writer: { write: jest.fn() },
      protection: { keyHex: KEY_HEX, keyId: 'kid-1' },
    });

    await expect(probe.probe()).resolves.toEqual({
      writeGateReady: true,
      failureCompensationReady: true,
      protectionKeyReady: true,
    });
  });

  it('安装身份未初始化 ⇒ 写/同步闸门未就绪', async () => {
    const { probe } = buildProbe({
      installation: null,
      writer: { write: jest.fn() },
      protection: { keyHex: KEY_HEX, keyId: 'kid-1' },
    });

    const report = await probe.probe();
    expect(report.writeGateReady).toBe(false);
    expect(report.failureCompensationReady).toBe(true);
    expect(report.protectionKeyReady).toBe(true);
  });

  it('恢复写回端口未注册 ⇒ 失败回滚补偿未就绪', async () => {
    const { probe } = buildProbe({
      installation: { installationId: 'inst-1' },
      protection: { keyHex: KEY_HEX, keyId: 'kid-1' },
    });

    const report = await probe.probe();
    expect(report.failureCompensationReady).toBe(false);
  });

  it('保护密钥材料缺失或不可解析 ⇒ 解密材料未就绪', async () => {
    const missing = buildProbe({
      installation: { installationId: 'inst-1' },
      writer: { write: jest.fn() },
      protection: null,
    });
    await expect(missing.probe.probe()).resolves.toMatchObject({ protectionKeyReady: false });

    const invalid = buildProbe({
      installation: { installationId: 'inst-1' },
      writer: { write: jest.fn() },
      protection: { keyHex: 'not-a-key', keyId: 'kid-1' },
    });
    await expect(invalid.probe.probe()).resolves.toMatchObject({ protectionKeyReady: false });
  });

  it('探测异常 ⇒ 按未就绪处理（不因异常把不可用说成可用）', async () => {
    const { probe } = buildProbe({
      installation: { installationId: 'inst-1' },
      writer: { write: jest.fn() },
      protection: { keyHex: KEY_HEX, keyId: 'kid-1' },
      failQuery: true,
    });

    await expect(probe.probe()).resolves.toMatchObject({ writeGateReady: false });
  });
});
