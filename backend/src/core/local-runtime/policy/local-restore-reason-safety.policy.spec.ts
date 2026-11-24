// src/core/local-runtime/policy/local-restore-reason-safety.policy.spec.ts

/**
 * 处置原因敏感内容识别的定向测试（任务 09 剩余问题 01）。
 *
 * 断言写的是**期望行为**：
 * - 普通中文运维原因必须**照常可用**（不得因为收紧而把正常处置挡在门外）；
 * - 可明确识别的凭据赋值／令牌、系统绝对路径必须被识别；
 * - 识别结果**只带类别**，不带命中原文（不回显＝不回显到日志与响应）。
 *
 * 同时把"规则**不可能穷尽**识别全部秘密"这条限制固化成可见事实：
 * 拆分写法不在规则覆盖内，测试只证明"未覆盖"这一事实，不假装已被拦住。
 */

import {
  detectLocalRestoreReasonSensitiveContent,
  type LocalRestoreReasonSensitiveKind,
} from './local-restore-reason-safety.policy';

const kindOf = (value: string): LocalRestoreReasonSensitiveKind | null =>
  detectLocalRestoreReasonSensitiveContent(value)?.kind ?? null;

describe('处置原因 · 普通运维原因照常可用', () => {
  const allowed = [
    '恢复已终态，人工核对数据一致后受控解除',
    '临时排障：token 已失效，请重新获取',
    'password reset 已完成，运维已确认',
    '设备已恢复写入，比例 1/2 与 2/3 均已核对',
    '参照 A/B 方案对比后放行',
    '恢复成功但解冻失败，已人工确认数据一致',
  ];

  for (const reason of allowed) {
    it(`不误伤：${reason}`, () => {
      expect(kindOf(reason)).toBeNull();
    });
  }
});

describe('处置原因 · 凭据赋值／令牌必须被识别', () => {
  const credentialLike = [
    'token=FAKE_EXAMPLE_SECRET',
    'token=FAKE_EXAMPLE_SECRET /srv/private',
    'password=Hunter2',
    'PASSWORD: Hunter2',
    'api_key: abc123def456',
    'apiKey=abc123def456',
    'secret=FAKE_EXAMPLE_SECRET',
    'access_token=FAKE_EXAMPLE_SECRET',
    'Authorization=Bearer FAKE_EXAMPLE_SECRET',
    'Bearer FAKE_EXAMPLE_SECRET',
    'token FAKE_EXAMPLE_SECRET',
    '口令：P@ssw0rd',
    '密码：Hunter2',
    '密钥 = FAKE_EXAMPLE_SECRET',
  ];

  for (const reason of credentialLike) {
    it(`识别为凭据：${reason}`, () => {
      expect(kindOf(reason)).toBe('CREDENTIAL_LIKE');
    });
  }
});

describe('处置原因 · 系统绝对路径必须被识别', () => {
  const absolutePaths = [
    '/srv/private',
    '/etc/passwd 已清理',
    '见 /var/lib/lithography 目录',
    'C:\\Windows\\System32',
    'C:/Users/admin/Desktop',
    '\\\\host\\share\\file',
  ];

  for (const reason of absolutePaths) {
    it(`识别为绝对路径：${reason}`, () => {
      expect(kindOf(reason)).toBe('ABSOLUTE_PATH');
    });
  }
});

describe('处置原因 · 识别结果不携带原文', () => {
  it('命中结果只带类别，不含命中内容', () => {
    const finding = detectLocalRestoreReasonSensitiveContent('token=FAKE_EXAMPLE_SECRET');
    expect(finding).toEqual({ kind: 'CREDENTIAL_LIKE' });
    expect(JSON.stringify(finding)).not.toContain('FAKE_EXAMPLE_SECRET');
  });

  it('空串与纯空白不命中', () => {
    expect(detectLocalRestoreReasonSensitiveContent('')).toBeNull();
    expect(detectLocalRestoreReasonSensitiveContent('   ')).toBeNull();
  });
});

describe('处置原因 · 规则的剩余风险（如实固化，不假装覆盖）', () => {
  it('不含赋值的普通描述不在规则覆盖内（文档化的剩余风险）', () => {
    // 这条断言固化的是"**未覆盖**"这一事实：规则不声称能识别所有秘密。
    expect(kindOf('token 见运维工单号 20261124')).toBeNull();
  });

  it('单段斜杠不是系统绝对路径（避免误伤散文）', () => {
    expect(kindOf('/tmp')).toBeNull();
  });
});
