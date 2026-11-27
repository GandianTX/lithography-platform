// src/infrastructure/database/reference-document-cleanup-claim.spec.ts

import { decideReferenceDocumentCleanupClaim } from '../../../test/utils/e2e-scoped-cleanup';

/**
 * 离线检查 E2E 清理助手的 reference_document 单行认领裁决（任务 07 收口），
 * 不启动 Nest、不连接数据库、不写入或删除任何行。
 *
 * 覆盖反例：库内已有资料、创建人相同但非本轮创建、身份碰撞、归属未知、
 * 登记事实不匹配（登记事实本体由 verifyOwnedExpectations 另行核对，
 * 这里验证「无登记证据时不得仅凭创建人认领归属待核实行」的失败关闭分支）。
 */

const BASE = {
  ownerOrganizationId: null,
  createdByAccountId: 900001,
  updatedByAccountId: null,
  sourceSubmissionId: null,
  sourceRevisionId: null,
  roundOrganizationIds: [910001],
  roundAccountIds: [900001],
  roundSubmissionIds: [] as number[],
  roundRevisionIds: [] as number[],
  registeredInOwnedLedger: false,
};

describe('历史维修记录清理认领裁决（离线，不连接数据库）', () => {
  it('归属未知 + 创建人在本轮 + 无登记证据、无来源事实：失败关闭，不认领', () => {
    // 身份碰撞反例：同一工程师账号在更早轮次/手工遗留的归属待核实资料，
    // 仅凭创建人相同扩大删除范围会误删非本轮数据。
    expect(decideReferenceDocumentCleanupClaim(BASE)).toEqual({
      allowed: false,
      reason:
        '归属未知且无登记归属证据、无本轮来源投稿/版本事实，仅凭创建人相同不足以认领，拒绝删除',
    });
  });

  it('归属未知 + 创建人在本轮 + owned 台账已登记真实 ID：允许认领', () => {
    expect(decideReferenceDocumentCleanupClaim({ ...BASE, registeredInOwnedLedger: true })).toEqual(
      { allowed: true, reason: null },
    );
  });

  it('归属未知 + 创建人在本轮 + 来源投稿落在本轮：允许认领', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        sourceSubmissionId: 930001,
        roundSubmissionIds: [930001],
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it('归属未知 + 创建人在本轮 + 来源版本落在本轮：允许认领', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        sourceRevisionId: 940001,
        roundRevisionIds: [940001],
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it('归属组织落在本轮 + 创建人在本轮：正常认领', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        ownerOrganizationId: 910001,
        registeredInOwnedLedger: false,
      }),
    ).toEqual({ allowed: true, reason: null });
  });

  it('归属组织不在本轮（含来源投稿跨组织）：拒绝删除', () => {
    expect(decideReferenceDocumentCleanupClaim({ ...BASE, ownerOrganizationId: 910002 })).toEqual({
      allowed: false,
      reason: '归属组织不在本轮范围（含来源投稿跨组织），拒绝删除',
    });
  });

  it('创建人不在本轮账号范围：拒绝删除', () => {
    expect(decideReferenceDocumentCleanupClaim({ ...BASE, createdByAccountId: 900002 })).toEqual({
      allowed: false,
      reason: '创建人账号不在本轮范围，拒绝删除',
    });
  });

  it('更新人不在本轮账号范围：拒绝删除', () => {
    expect(decideReferenceDocumentCleanupClaim({ ...BASE, updatedByAccountId: 900002 })).toEqual({
      allowed: false,
      reason: '更新人账号不在本轮范围，拒绝删除',
    });
  });

  it('来源投稿不在本轮：拒绝删除', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        sourceSubmissionId: 930002,
        roundSubmissionIds: [930001],
      }),
    ).toEqual({ allowed: false, reason: '来源投稿不在本轮范围，拒绝删除' });
  });

  it('来源版本不在本轮：拒绝删除', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        sourceRevisionId: 940002,
        roundRevisionIds: [940001],
      }),
    ).toEqual({ allowed: false, reason: '来源版本不在本轮范围，拒绝删除' });
  });

  it('归属组织在轮但创建人不在本轮账号：仍拒绝（组织归属不能替代创建人证明）', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        ownerOrganizationId: 910001,
        createdByAccountId: 900002,
      }),
    ).toEqual({ allowed: false, reason: '创建人账号不在本轮范围，拒绝删除' });
  });

  it('归属未知 + 来源投稿 ID 在轮但创建人不在本轮：仍拒绝（来源证明不能替代创建人证明）', () => {
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        sourceSubmissionId: 930001,
        roundSubmissionIds: [930001],
        createdByAccountId: 900002,
      }),
    ).toEqual({ allowed: false, reason: '创建人账号不在本轮范围，拒绝删除' });
  });

  it('本轮组织/投稿/版本集合全空 + 来源投稿非空：拒绝删除（不凭空认领来源事实）', () => {
    expect(decideReferenceDocumentCleanupClaim({ ...BASE, sourceSubmissionId: 930003 })).toEqual({
      allowed: false,
      reason: '来源投稿不在本轮范围，拒绝删除',
    });
  });

  it('归属未知 + 台账已登记 + 来源投稿指向本轮之外：仍失败关闭（来源外部链接宁可不删，保留现场）', () => {
    // 即使该行已按真实 ID 登记台账，来源投稿指向本轮之外的行说明存在外部来源
    // 关联；裁决选择保守拒绝而非顺带认领，避免误删被外部来源引用的资料。
    // 台账登记事实与库内 source_submission_id 的一致性由 verifyOwnedExpectations 另行核对。
    expect(
      decideReferenceDocumentCleanupClaim({
        ...BASE,
        registeredInOwnedLedger: true,
        sourceSubmissionId: 930002,
        roundSubmissionIds: [930001],
      }),
    ).toEqual({ allowed: false, reason: '来源投稿不在本轮范围，拒绝删除' });
  });
});
