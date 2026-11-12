// scripts/mock-v13/manifest.spec.ts

/**
 * 清单契约测试：角色、组织归属、工单状态与稳定 UUID 是造数的唯一事实来源，
 * 这里在离线阶段锁定最低数量与数据关系，避免实库执行后才发现口径不一致。
 */

/// <reference types="jest" />

import {
  ACCOUNTS,
  DOCUMENT_TITLES,
  LOGIN_PREFIX,
  MOCK_LABEL,
  ORGANIZATIONS,
  PACK_IDS,
  REPORT_KEYS,
  REPORT_TITLES,
  TICKETS,
  mockEmail,
  mockUuid,
} from './manifest';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const accountByKey = (key: string) => {
  const account = ACCOUNTS.find((item) => item.key === key);
  if (!account) {
    throw new Error(`清单缺少账号: ${key}`);
  }
  return account;
};

const ticketByKey = (key: string) => {
  const ticket = TICKETS.find((item) => item.key === key);
  if (!ticket) {
    throw new Error(`清单缺少工单: ${key}`);
  }
  return ticket;
};

describe('账号与角色', () => {
  it('登录名全部带 mock_v13_ 前缀，邮箱使用不可投递测试域', () => {
    for (const account of ACCOUNTS) {
      expect(account.loginName.startsWith(LOGIN_PREFIX)).toBe(true);
      expect(mockEmail(account.loginName)).toBe(`${account.loginName}@mock-v13.invalid`);
    }
  });

  it('至少有 8 个可用的基础账号（不含停用与待审/拒绝负例）', () => {
    const usable = ACCOUNTS.filter(
      (account) =>
        account.accountStatus === 'ACTIVE' &&
        account.userState === 'ACTIVE' &&
        account.organization !== null,
    );
    expect(usable.length).toBeGreaterThanOrEqual(8);
    expect(usable.map((account) => account.key)).toEqual(
      expect.arrayContaining([
        'admin-l1-a',
        'admin-l1-b',
        'admin-l2-a',
        'admin-l2-b',
        'engineer-a',
        'engineer-b',
        'customer-a',
        'customer-b',
      ]),
    );
  });

  it('一级管理员 2 个且绑定平台组织，二级管理员 2 个且分别绑定 A/B 受管公司', () => {
    const level1 = ACCOUNTS.filter((account) => account.adminLevel === 1);
    const level2 = ACCOUNTS.filter((account) => account.adminLevel === 2);
    expect(level1).toHaveLength(2);
    expect(level2).toHaveLength(2);
    expect(level1.every((account) => account.organization === 'PLATFORM')).toBe(true);
    expect(level2.map((account) => account.organization)).toEqual(['A', 'B']);
    expect(level2.every((account) => account.role === 'SUPER_ADMIN')).toBe(true);
  });

  it('A/B 各有一个启用工程师和客户，且同公司另有一个客户用于本人范围反例', () => {
    const engineerA = accountByKey('engineer-a');
    const engineerB = accountByKey('engineer-b');
    const customerA = accountByKey('customer-a');
    const customerB = accountByKey('customer-b');
    const customerA2 = accountByKey('customer-a2');

    expect([engineerA.role, engineerB.role]).toEqual(['ENGINEER', 'ENGINEER']);
    expect([engineerA.organization, engineerB.organization]).toEqual(['A', 'B']);
    expect(customerA.profileOrganization).toBe('A');
    expect(customerB.profileOrganization).toBe('B');
    expect(customerA2.organization).toBe(customerA.organization);
    expect(customerA2.loginName).not.toBe(customerA.loginName);
  });

  it('待审/拒绝/停用负例不占用基础名额，且申请账号符合正式注册形态', () => {
    const pending = accountByKey('pending-engineer');
    const rejected = accountByKey('rejected-engineer');
    const disabled = accountByKey('disabled-customer');

    expect(pending.organization).toBeNull();
    expect(rejected.organization).toBeNull();
    expect(disabled.accountStatus).toBe('SUSPENDED');
    expect(disabled.userState).toBe('SUSPENDED');
    expect([pending.role, rejected.role, disabled.role]).toEqual([
      'ENGINEER',
      'ENGINEER',
      'CUSTOMER',
    ]);
    expect([pending.accountStatus, rejected.accountStatus]).toEqual(['PENDING', 'PENDING']);
    expect([pending.userState, rejected.userState]).toEqual(['PENDING', 'PENDING']);
  });

  it('受管公司均为启用状态的 PEER 服务公司', () => {
    expect(ORGANIZATIONS).toHaveLength(2);
    for (const organization of ORGANIZATIONS) {
      expect(organization.isManagedCompany).toBe(true);
      expect(organization.isServiceProvider).toBe(true);
      expect(organization.name.startsWith(MOCK_LABEL)).toBe(true);
    }
  });
});

describe('稳定标识', () => {
  it('mockUuid 对同一键恒定，并符合 UUID v5 形式', () => {
    expect(mockUuid('ticket:a-pending')).toBe(mockUuid('ticket:a-pending'));
    expect(mockUuid('ticket:a-pending')).toMatch(UUID_PATTERN);
  });

  it('不同键派生不同 UUID', () => {
    expect(mockUuid('ticket:a-pending')).not.toBe(mockUuid('ticket:a-in-progress'));
  });
});

describe('工单与状态', () => {
  it('至少 3 组有效工单 + 2 条未转单报修', () => {
    const converted = TICKETS.filter((ticket) => ticket.converted);
    const unconverted = TICKETS.filter((ticket) => !ticket.converted);
    expect(converted.length).toBeGreaterThanOrEqual(3);
    expect(unconverted.length).toBeGreaterThanOrEqual(2);
    expect(unconverted.every((ticket) => ticket.acceptedByKey === null)).toBe(true);
    expect(unconverted.every((ticket) => ticket.handlingStatus === null)).toBe(true);
  });

  it('待接单、处理中、已结单未写总结三种状态齐备', () => {
    const pending = ticketByKey('a-pending');
    const inProgress = ticketByKey('a-in-progress');
    const closed = ticketByKey('a-closed-no-summary');

    expect(pending.acceptedByKey).toBeNull();
    expect(pending.closureStatus).toBe('OPEN');

    expect(inProgress.acceptedByKey).not.toBeNull();
    expect(inProgress.handlingStatus).toBe('IN_PROGRESS');
    expect(inProgress.closureReason).not.toBeNull();
    expect(inProgress.handlingEndedAt).toBeNull();

    expect(closed.acceptedByKey).not.toBeNull();
    expect(closed.handlingStatus).toBe('COMPLETED');
    expect(closed.closureStatus).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
  });

  it('客户公司、接单工程师公司与维修公司一致', () => {
    for (const ticket of TICKETS) {
      const customer = accountByKey(ticket.customerKey);
      expect(customer.profileOrganization).toBe(ticket.serviceOrganization);
      if (ticket.acceptedByKey) {
        const engineer = accountByKey(ticket.acceptedByKey);
        expect(engineer.role).toBe('ENGINEER');
        expect(engineer.organization).toBe(ticket.serviceOrganization);
      }
    }
  });

  it('处理中工单必须带结单原因，已结单工单带结单时间', () => {
    const inProgress = TICKETS.filter((ticket) => ticket.handlingStatus === 'IN_PROGRESS');
    expect(inProgress.every((ticket) => Boolean(ticket.closureReason))).toBe(true);
    const closed = TICKETS.filter((ticket) => ticket.closureStatus === 'CLOSED');
    expect(closed.every((ticket) => ticket.closedAt instanceof Date)).toBe(true);
  });
});

describe('报告与资料最低数量', () => {
  it('2 份独立草稿 + 2 份正式报告，标题带 Mock 标记', () => {
    expect(Object.keys(REPORT_KEYS)).toHaveLength(4);
    expect(REPORT_TITLES.draftA.startsWith(MOCK_LABEL)).toBe(true);
    expect(REPORT_TITLES.draftB.startsWith(MOCK_LABEL)).toBe(true);
    expect(REPORT_TITLES.formalA).toContain('正式报告');
    expect(REPORT_TITLES.formalB).toContain('工单总结');
  });

  it('A/B 两家公司各有可在线下载的正式资料', () => {
    expect(DOCUMENT_TITLES.materialA.startsWith(MOCK_LABEL)).toBe(true);
    expect(DOCUMENT_TITLES.reportA).toContain('星港');
    expect(DOCUMENT_TITLES.reportB).toContain('远岚');
    expect(DOCUMENT_TITLES.materialOffline).toContain('下架');
  });
});

describe('数据包', () => {
  it('包含 9 个可独立选择的数据包，P0 在前 P1 在后', () => {
    expect(PACK_IDS).toHaveLength(9);
    expect(PACK_IDS.slice(0, 5)).toEqual([
      'p0-org-accounts',
      'p0-equipment',
      'p0-repair',
      'p0-reports',
      'p0-documents',
    ]);
    expect(PACK_IDS.slice(5)).toEqual(['p1-ai', 'p1-local', 'p1-packages', 'p1-backup']);
  });
});
