// src/usecases/account/my-account-settings.input.normalize.spec.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeMyAccountSettingsAccountId,
  normalizeMyAccountSettingsUpdateInput,
} from './my-account-settings.input.normalize';

/**
 * P1：`normalizeMyAccountSettingsAccountId()` 的纯规则单测。
 *
 * 自助设置只读 Query 无客户端输入，本 normalize 唯一职责是对 Session 携带的可信 `accountId`
 * 做防御性前置校验：正整数放行，畸形（0 / 负数 / 非整数 / NaN / 非安全整数）失败关闭，
 * 且失败关闭为输入类错误（`BAD_USER_INPUT`），绝不塌缩为 `UNAUTHENTICATED`。
 */
describe('normalizeMyAccountSettingsAccountId', () => {
  const session = (accountId: unknown): UsecaseSession =>
    ({
      accountId,
      roles: [IdentityTypeEnum.CUSTOMER],
      activeRole: IdentityTypeEnum.CUSTOMER,
    }) as unknown as UsecaseSession;

  it('放行正整数 accountId 并原样返回', () => {
    expect(normalizeMyAccountSettingsAccountId(session(1))).toBe(1);
    expect(normalizeMyAccountSettingsAccountId(session(42))).toBe(42);
  });

  it.each([
    ['0', 0],
    ['负数', -1],
    ['非整数', 3.14],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['非安全整数', Number.MAX_SAFE_INTEGER + 2],
  ])('对 %s 失败关闭为 INVALID_LIMIT_VALUE', (_label, accountId) => {
    expect(() => normalizeMyAccountSettingsAccountId(session(accountId))).toThrow(
      expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE }),
    );
  });

  it('失败关闭不使用会被映射为 UNAUTHENTICATED 的 AUTH/JWT 码', () => {
    try {
      normalizeMyAccountSettingsAccountId(session(0));
      throw new Error('预期抛出 DomainError，但调用成功了');
    } catch (error) {
      expect(error).toMatchObject({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE });
      expect((error as { code: string }).code).not.toContain('ACCOUNT_NOT_FOUND');
    }
  });
});

/**
 * P2：`normalizeMyAccountSettingsUpdateInput()` 中 `realName` 的三态收敛。
 *
 * `undefined` = 不修改；`null` / 空串 / 纯空白 = 清空；非空字符串 trim 后设置；
 * 长度上限与 `base_user_info.real_name`（varchar(200)）一致，超长按输入错误拒绝。
 */
describe('normalizeMyAccountSettingsUpdateInput realName', () => {
  const normalizeRealName = (realName: unknown) =>
    normalizeMyAccountSettingsUpdateInput({
      loginName: undefined,
      loginEmail: undefined,
      nickname: undefined,
      realName,
      companyName: undefined,
      phone: undefined,
      contactEmail: undefined,
    }).realName;

  it('undefined = 不修改', () => {
    expect(normalizeRealName(undefined)).toBeUndefined();
  });

  it.each([
    ['显式 null', null],
    ['空字符串', ''],
    ['纯空白', '   '],
  ])('%s = 清空', (_label, value) => {
    expect(normalizeRealName(value)).toBeNull();
  });

  it('非空字符串 trim 后原样返回（不套用其他字段规则）', () => {
    expect(normalizeRealName('  李四  ')).toBe('李四');
  });

  it('长度 200 放行，超过 200 拒绝为 INVALID_LIMIT_VALUE', () => {
    expect(normalizeRealName('张'.repeat(200))).toBe('张'.repeat(200));
    expect(() => normalizeRealName('张'.repeat(201))).toThrow(
      expect.objectContaining({ code: INPUT_NORMALIZE_ERROR.INVALID_LIMIT_VALUE }),
    );
  });
});
