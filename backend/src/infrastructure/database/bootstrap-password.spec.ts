import { assertBootstrapPassword } from './bootstrap-password';

describe('初始化密码策略（不连接实库）', () => {
  it('接受符合项目策略的强密码', () => {
    expect(() => assertBootstrapPassword('管理员 admin01', 'Xk7#mQ2!vR9')).not.toThrow();
  });

  it('拒绝弱片段、过短与首尾空格，且错误信息不回显密码', () => {
    expect(() => assertBootstrapPassword('管理员 admin01', 'password123')).toThrow(/密码策略/);
    expect(() => assertBootstrapPassword('管理员 admin01', 'Ab1!')).toThrow(/密码策略/);
    expect(() => assertBootstrapPassword('管理员 admin01', ' Xk7#mQ2!vR9 ')).toThrow(/密码策略/);

    try {
      assertBootstrapPassword('管理员 admin01', 'password123');
      throw new Error('预期抛出密码策略错误');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('管理员 admin01');
      expect(message).not.toContain('password123');
    }
  });
});
