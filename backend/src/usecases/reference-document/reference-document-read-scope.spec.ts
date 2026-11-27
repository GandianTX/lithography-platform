// src/usecases/reference-document/reference-document-read-scope.spec.ts

/// <reference types="jest" />

import type { UsecaseSession } from '@app-types/auth/session.types';
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { resolveReferenceDocumentReadScope } from './reference-document-read-scope';

const ORG_ID = 910001;

const session = (overrides: Record<string, unknown>): UsecaseSession =>
  ({
    accountId: 900001,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    ...overrides,
  }) as unknown as UsecaseSession;

const makeReaders = (adminLevel: number | null) => ({
  accountQueryService: {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(adminLevel),
  },
  organizationContextService: {
    resolveForAccount: jest.fn().mockResolvedValue({ organizationId: ORG_ID, memberRole: 'ADMIN' }),
  },
});

describe('resolveReferenceDocumentReadScope（历史维修记录读侧范围）', () => {
  it('工程师：仅本公司范围，等级读取不参与决策', async () => {
    const readers = makeReaders(1);
    await expect(
      resolveReferenceDocumentReadScope({ session: session({}), ...readers }),
    ).resolves.toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
    expect(readers.accountQueryService.findAdminLevelByAccountId).not.toHaveBeenCalled();
  });

  it('二级管理员（admin_level=2）：仅本公司范围', async () => {
    const readers = makeReaders(2);
    await expect(
      resolveReferenceDocumentReadScope({
        session: session({ roles: ['SUPER_ADMIN', 'ENGINEER'], activeRole: 'SUPER_ADMIN' }),
        ...readers,
      }),
    ).resolves.toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
  });

  it('一级管理员（admin_level=1）：全范围，且不要求组织成员关系', async () => {
    const readers = makeReaders(1);
    readers.organizationContextService.resolveForAccount.mockRejectedValue(
      new Error('不应发生组织解析'),
    );
    await expect(
      resolveReferenceDocumentReadScope({
        session: session({ roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' }),
        ...readers,
      }),
    ).resolves.toEqual({ kind: 'GLOBAL' });
    expect(readers.organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });

  it('管理员等级缺失：按本公司范围失败收紧（不放大为全范围）', async () => {
    const readers = makeReaders(null);
    await expect(
      resolveReferenceDocumentReadScope({
        session: session({ roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' }),
        ...readers,
      }),
    ).resolves.toEqual({ kind: 'ORGANIZATION', organizationId: ORG_ID });
  });

  it('客户：在范围决议与任何资料读取之前拒绝', async () => {
    const readers = makeReaders(1);
    await expect(
      resolveReferenceDocumentReadScope({
        session: session({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER' }),
        ...readers,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS });
    expect(readers.accountQueryService.findAdminLevelByAccountId).not.toHaveBeenCalled();
    expect(readers.organizationContextService.resolveForAccount).not.toHaveBeenCalled();
  });
});
