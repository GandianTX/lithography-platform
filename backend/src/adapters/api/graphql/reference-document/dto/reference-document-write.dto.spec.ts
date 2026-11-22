// src/adapters/api/graphql/reference-document/dto/reference-document-write.dto.spec.ts
//
// 任务 07 R053/R058–R061 协议层版本门槛回归：
// expected_version 的令牌是 reference_document.current_revision_no，默认 0
// （尚无管理修订），故协议层必须放行 0，只拒绝负数与非整数；账号/组织 ID
// 等其它数值输入的下界仍是 1，不随版本口径放宽。

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  AdminDeleteReferenceDocumentInput,
  CorrectReferenceDocumentOwnershipInput,
  OfflineReferenceDocumentInput,
  ReviseReferenceDocumentInput,
} from './reference-document-write.dto';

const errorProps = async (input: object): Promise<string[]> => {
  const errors = await validate(input);
  return errors.map((error) => error.property);
};

/** 四类管理输入的合法基线载荷（expectedVersion 由各用例覆盖） */
const cases = [
  {
    label: 'ReviseReferenceDocumentInput',
    build: (expectedVersion: number | undefined) =>
      plainToInstance(ReviseReferenceDocumentInput, {
        expectedVersion,
        reason: '首次修订',
        title: '标题',
      }),
  },
  {
    label: 'OfflineReferenceDocumentInput',
    build: (expectedVersion: number | undefined) =>
      plainToInstance(OfflineReferenceDocumentInput, { expectedVersion, reason: '首次下架' }),
  },
  {
    label: 'AdminDeleteReferenceDocumentInput',
    build: (expectedVersion: number | undefined) =>
      plainToInstance(AdminDeleteReferenceDocumentInput, {
        expectedVersion,
        reason: '首次管理删除',
      }),
  },
  {
    label: 'CorrectReferenceDocumentOwnershipInput',
    build: (expectedVersion: number | undefined) =>
      plainToInstance(CorrectReferenceDocumentOwnershipInput, {
        expectedVersion,
        verificationReason: '首次归属核实',
        ownerOrganizationId: 910001,
      }),
  },
] as const;

describe('参考资料写侧 DTO · expected_version 下界', () => {
  it.each(cases)('$label 接受首次管理操作的 expected_version = 0', async ({ build }) => {
    await expect(validate(build(0) as object)).resolves.toHaveLength(0);
  });

  it.each(cases)('$label 拒绝负数的 expected_version', async ({ build }) => {
    await expect(errorProps(build(-1) as object)).resolves.toEqual(['expectedVersion']);
  });

  it.each(cases)('$label 拒绝非整数的 expected_version', async ({ build }) => {
    await expect(errorProps(build(1.5) as object)).resolves.toEqual(['expectedVersion']);
  });

  it.each(cases)('$label 拒绝缺失的 expected_version', async ({ build }) => {
    await expect(errorProps(build(undefined) as object)).resolves.toEqual(['expectedVersion']);
  });

  it('归属更正的账号/公司 ID 下界保持 1，不随 expected_version 放宽', async () => {
    const input = plainToInstance(CorrectReferenceDocumentOwnershipInput, {
      expectedVersion: 0,
      verificationReason: '核实',
      createdByAccountId: 0,
      ownerOrganizationId: 0,
    });

    await expect(errorProps(input)).resolves.toEqual(['createdByAccountId', 'ownerOrganizationId']);
  });

  it('归属更正显式给定合法账号/公司 ID 时通过', async () => {
    const input = plainToInstance(CorrectReferenceDocumentOwnershipInput, {
      expectedVersion: 0,
      verificationReason: '核实',
      createdByAccountId: 900009,
      ownerOrganizationId: 910001,
    });

    await expect(validate(input)).resolves.toHaveLength(0);
  });
});
