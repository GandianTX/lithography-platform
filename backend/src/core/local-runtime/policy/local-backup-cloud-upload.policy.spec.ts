// src/core/local-runtime/policy/local-backup-cloud-upload.policy.spec.ts
/**
 * 云备份上传**纯裁决**的定向测试（任务 09 第 10 项 D3／D5／D7）。
 */
import {
  CLOUD_UPLOAD_FAILURE_CODES,
  decideCloudUploadPackageConsistency,
  decideCloudUploadSizeLimit,
  decideCloudUploadSuccess,
  decideCloudUploadFailureDisposition,
  isTerminalCloudUploadFailure,
} from './local-backup-cloud-upload.policy';

describe('云备份上传纯裁决', () => {
  describe('大小上限（D3）', () => {
    it('单件与总量都在上限内 ⇒ 放行', () => {
      const verdict = decideCloudUploadSizeLimit({
        files: [
          { relativePath: 'payload.enc', byteSize: 100 },
          { relativePath: 'files/a.txt', byteSize: 200 },
        ],
        maxFileBytes: 1000,
        maxPackageBytes: 1000,
      });
      expect(verdict).toEqual({ allowed: true });
    });

    it('单件超限 ⇒ 拒绝（受控码）', () => {
      const verdict = decideCloudUploadSizeLimit({
        files: [{ relativePath: 'files/a.txt', byteSize: 2000 }],
        maxFileBytes: 1000,
        maxPackageBytes: 10_000,
      });
      expect(verdict).toMatchObject({
        allowed: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
      });
    });

    it('总量超限（单件都合法）⇒ 拒绝（受控码）', () => {
      const verdict = decideCloudUploadSizeLimit({
        files: [
          { relativePath: 'payload.enc', byteSize: 600 },
          { relativePath: 'files/a.txt', byteSize: 600 },
        ],
        maxFileBytes: 1000,
        maxPackageBytes: 1000,
      });
      expect(verdict).toMatchObject({
        allowed: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
      });
    });

    it('清单声明的字节数溢出时按饱和值比较（结论不翻转，数字不失控）', () => {
      const verdict = decideCloudUploadSizeLimit({
        files: [
          { relativePath: 'payload.enc', byteSize: 9e15 },
          { relativePath: 'files/a.txt', byteSize: 9e15 },
        ],
        maxFileBytes: Number.MAX_SAFE_INTEGER,
        maxPackageBytes: Number.MAX_SAFE_INTEGER,
      });
      expect(verdict).toMatchObject({
        allowed: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_TOO_LARGE,
      });
    });
  });

  describe('清单 ↔ 字节一致性（D5）', () => {
    it('逐项一致 ⇒ 一致', () => {
      const verdict = decideCloudUploadPackageConsistency({
        declared: [{ relativePath: 'files/a.txt', byteSize: 3, sha256: 'aa' }],
        actual: [{ relativePath: 'files/a.txt', byteSize: 3, sha256: 'aa' }],
      });
      expect(verdict).toEqual({ consistent: true });
    });

    it('清单登记但包内缺失 ⇒ 不一致并给出缺失清单', () => {
      const verdict = decideCloudUploadPackageConsistency({
        declared: [{ relativePath: 'files/a.txt', byteSize: 3, sha256: 'aa' }],
        actual: [],
      });
      expect(verdict).toMatchObject({
        consistent: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
        missing: ['files/a.txt'],
      });
    });

    it('字节数或摘要不符 ⇒ 不一致并给出串件清单', () => {
      const verdict = decideCloudUploadPackageConsistency({
        declared: [{ relativePath: 'files/a.txt', byteSize: 3, sha256: 'aa' }],
        actual: [{ relativePath: 'files/a.txt', byteSize: 4, sha256: 'bb' }],
      });
      expect(verdict).toMatchObject({
        consistent: false,
        code: CLOUD_UPLOAD_FAILURE_CODES.CLOUD_PACKAGE_INCOMPLETE,
        mismatched: ['files/a.txt'],
      });
    });

    it('包内多余但清单未登记的文件不算失败（只发清单登记的内容）', () => {
      const verdict = decideCloudUploadPackageConsistency({
        declared: [{ relativePath: 'payload.enc', byteSize: 3, sha256: 'aa' }],
        actual: [
          { relativePath: 'payload.enc', byteSize: 3, sha256: 'aa' },
          { relativePath: 'files/half-copied.bin', byteSize: 9, sha256: 'cc' },
        ],
      });
      expect(verdict).toEqual({ consistent: true });
    });
  });

  describe('上传成功判定（D7）', () => {
    it('有引用 ＋ 完整回执 ⇒ 成功', () => {
      expect(
        decideCloudUploadSuccess({
          cloudReference: 'cloud://pkg-1',
          receipt: '{"received":true}',
        }),
      ).toEqual({ succeeded: true });
    });

    it('缺引用 ⇒ 失败（响应非法）', () => {
      expect(
        decideCloudUploadSuccess({
          cloudReference: null,
          receipt: '{"received":true}',
        }),
      ).toMatchObject({ succeeded: false, code: 'CLOUD_INVALID_RESPONSE' });
    });

    it('回执不完整 ⇒ 失败（与清理授权同口径）', () => {
      expect(
        decideCloudUploadSuccess({
          cloudReference: 'cloud://pkg-1',
          receipt: 'ok',
        }),
      ).toMatchObject({ succeeded: false, code: 'CLOUD_INVALID_RESPONSE' });
    });

    it('回执完整性由本模块自行裁决（不再由调用方注入结论）', () => {
      // 空回执 ⇒ 不完整 ⇒ 失败
      expect(
        decideCloudUploadSuccess({ cloudReference: 'cloud://pkg-1', receipt: null }),
      ).toMatchObject({ succeeded: false, code: 'CLOUD_INVALID_RESPONSE' });
      // 失败语义的回执 ⇒ 不完整 ⇒ 失败
      expect(
        decideCloudUploadSuccess({
          cloudReference: 'cloud://pkg-1',
          receipt: '{"status":"FAILED"}',
        }),
      ).toMatchObject({ succeeded: false, code: 'CLOUD_INVALID_RESPONSE' });
      // 明确成功语义 ⇒ 成功
      expect(
        decideCloudUploadSuccess({
          cloudReference: 'cloud://pkg-1',
          receipt: '{"status":"SUCCEEDED"}',
        }),
      ).toEqual({ succeeded: true });
    });
  });
});

describe('上传失败处置分类（第 10 项 L2：终态不再无限重试）', () => {
  it('本机包结构性失败 ⇒ 终态', () => {
    expect(decideCloudUploadFailureDisposition('CLOUD_PACKAGE_TOO_LARGE')).toBe('TERMINAL');
    expect(decideCloudUploadFailureDisposition('CLOUD_PACKAGE_INCOMPLETE')).toBe('TERMINAL');
    expect(decideCloudUploadFailureDisposition('CLOUD_PACKAGE_UNREADABLE')).toBe('TERMINAL');
  });

  it('远端/网络类失败 ⇒ 可重试（不臆造生产协议的终态语义）', () => {
    for (const code of [
      'CLOUD_NOT_CONFIGURED',
      'CLOUD_UNREACHABLE',
      'CLOUD_TIMEOUT',
      'CLOUD_SERVER_ERROR',
      'CLOUD_REJECTED',
      'CLOUD_INVALID_RESPONSE',
    ]) {
      expect(decideCloudUploadFailureDisposition(code)).toBe('RETRYABLE');
    }
  });

  it('未知码按可重试处理（不伪造成功、也不误判终态）', () => {
    expect(decideCloudUploadFailureDisposition('SOMETHING_ELSE')).toBe('RETRYABLE');
    expect(decideCloudUploadFailureDisposition(null)).toBe('RETRYABLE');
    expect(decideCloudUploadFailureDisposition(undefined)).toBe('RETRYABLE');
    expect(isTerminalCloudUploadFailure('CLOUD_PACKAGE_TOO_LARGE')).toBe(true);
    expect(isTerminalCloudUploadFailure('CLOUD_UNREACHABLE')).toBe(false);
  });
});
