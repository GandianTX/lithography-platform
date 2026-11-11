// src/infrastructure/database/reference-document-fixture-state.spec.ts

import {
  deriveReferenceDocumentFixtureState,
  withReferenceDocumentFixtureState,
  type ReferenceDocumentFixtureFacts,
} from '../../../test/utils/reference-document-fixture-state';

/**
 * 离线检查共用夹具状态生成逻辑，不启动 Nest、不连接数据库、不写入任何行。
 *
 * 覆盖 V13 三个必填状态字段的取值与组合，并保持原有用例的上下架/软删语义：
 * - 活跃未删 -> ONLINE；
 * - 已停用（deprecated）或已软删（deletedAt 非空）-> OFFLINE；
 * - 有组织归属 -> CONFIRMED，无归属 -> PENDING；
 * - 现有正文/文件夹具 -> MATERIAL。
 *
 * 本回归只证明夹具生成器的输出可满足实体枚举值，不代替 MySQL CHECK 与实库复验。
 */

const ACTIVE_FACTS: ReferenceDocumentFixtureFacts = {
  deprecated: false,
  deletedAt: null,
  ownerOrganizationId: 910001,
};

describe('参考资料夹具 V13 必填状态（离线，不连接数据库）', () => {
  it('活跃未删除且有组织归属的夹具落 ONLINE / CONFIRMED / MATERIAL', () => {
    expect(deriveReferenceDocumentFixtureState(ACTIVE_FACTS)).toEqual({
      publicationStatus: 'ONLINE',
      ownershipStatus: 'CONFIRMED',
      sourceKind: 'MATERIAL',
    });
  });

  it('已停用或已软删的夹具落 OFFLINE，保留原下架/软删语义', () => {
    const deletedAt = new Date('2026-09-01T00:00:00.000Z');

    expect(
      deriveReferenceDocumentFixtureState({
        deprecated: true,
        deletedAt,
        ownerOrganizationId: 910001,
      }),
    ).toEqual({
      publicationStatus: 'OFFLINE',
      ownershipStatus: 'CONFIRMED',
      sourceKind: 'MATERIAL',
    });

    expect(
      deriveReferenceDocumentFixtureState({
        deprecated: false,
        deletedAt,
        ownerOrganizationId: 910001,
      }),
    ).toEqual({
      publicationStatus: 'OFFLINE',
      ownershipStatus: 'CONFIRMED',
      sourceKind: 'MATERIAL',
    });
  });

  it('无组织归属的夹具落 PENDING，不被无条件填成 CONFIRMED', () => {
    expect(
      deriveReferenceDocumentFixtureState({
        deprecated: false,
        deletedAt: null,
        ownerOrganizationId: null,
      }),
    ).toEqual({
      publicationStatus: 'ONLINE',
      ownershipStatus: 'PENDING',
      sourceKind: 'MATERIAL',
    });
  });

  it('补值包装保留原夹具事实，并只新增三个 V13 必填状态字段', () => {
    const fixture = {
      id: 971,
      title: 'E2E 错误码手册',
      contentText: 'E-CHUCK-101',
      ...ACTIVE_FACTS,
    };

    const filled = withReferenceDocumentFixtureState(fixture);

    expect(filled).toEqual({
      ...fixture,
      publicationStatus: 'ONLINE',
      ownershipStatus: 'CONFIRMED',
      sourceKind: 'MATERIAL',
    });
    expect(Object.keys(filled).sort()).toEqual(
      [
        'contentText',
        'deletedAt',
        'deprecated',
        'id',
        'ownerOrganizationId',
        'ownershipStatus',
        'publicationStatus',
        'sourceKind',
        'title',
      ].sort(),
    );
  });
});
