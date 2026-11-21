// src/modules/lithography/queries/management-audit-event.query.service.spec.ts

import { MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import type { FindOperator, FindOptionsWhere, Repository } from 'typeorm';
import { ManagementAuditEventEntity } from '../entities/management-audit-event.entity';
import {
  MANAGEMENT_AUDIT_QUERY_OPERATIONS,
  type ManagementAuditListPagination,
} from '../management-audit.types';
import { ManagementAuditEventQueryService } from './management-audit-event.query.service';
import {
  ManagementAuditBusinessOperation,
  ManagementAuditResult,
} from '@app-types/models/management-audit.types';

type FindArgs = {
  where: FindOptionsWhere<ManagementAuditEventEntity>;
  order: Record<string, 'ASC' | 'DESC'>;
  skip: number;
  take: number;
};

const pagination = (
  overrides: Partial<ManagementAuditListPagination> = {},
): ManagementAuditListPagination => ({ page: 1, pageSize: 10, withTotal: true, ...overrides });

const makeEntity = (
  overrides: Partial<ManagementAuditEventEntity> = {},
): ManagementAuditEventEntity => ({
  eventId: '6f1f0a8e-6d8d-4a5e-9a9a-1f0b2c3d4e5f',
  actorAccountId: 1,
  actorAdminLevel: 1,
  organizationId: 2,
  operation: ManagementAuditBusinessOperation.ADMIN_DELETE_DOCUMENT,
  targetType: 'REFERENCE_DOCUMENT',
  targetId: 'doc-1001',
  result: ManagementAuditResult.SUCCEEDED,
  detail: JSON.stringify({ reason: '重复上传', contentMd: '# 正文' }),
  createdAt: new Date('2026-11-18T10:00:00.000Z'),
  ...overrides,
});

/**
 * 关键操作记录 QueryService 单测（任务 10 S1.1／S1.2）。
 *
 * 覆盖：固定三值白名单恒定进入 WHERE、二级按可信公司等值过滤、一级不追加公司条件、
 * 固定排序与 OFFSET 偏移、withTotal 语义、detail 投影不出原值、存储事实越界失败关闭。
 */
describe('ManagementAuditEventQueryService', () => {
  const createService = () => {
    const repository = { find: jest.fn(), count: jest.fn() };
    const service = new ManagementAuditEventQueryService(
      repository as unknown as Repository<ManagementAuditEventEntity>,
    );
    return { service, repository };
  };

  const firstFindArgs = (repository: { find: jest.Mock }): FindArgs =>
    repository.find.mock.calls[0][0] as FindArgs;

  it('一级管理员：WHERE 只含三类白名单，不追加公司条件', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([makeEntity()]);
    repository.count.mockResolvedValue(1);

    await service.listEvents({ organizationId: null, pagination: pagination() });

    const args = firstFindArgs(repository);
    const operation = args.where.operation as FindOperator<string>;
    expect(operation.type).toBe('in');
    expect(operation.value).toEqual([...MANAGEMENT_AUDIT_QUERY_OPERATIONS]);
    expect(operation.value).not.toContain('REISSUE_LEVEL2_CREDENTIAL');
    expect(operation.value).not.toContain('RESET_LEVEL2_CREDENTIAL');
    expect(args.where.organizationId).toBeUndefined();
  });

  it('二级管理员：按可信公司等值过滤（NULL 公司记录天然不可见）', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listEvents({ organizationId: 700002, pagination: pagination() });

    expect(firstFindArgs(repository).where.organizationId).toBe(700002);
  });

  it('排序固定为发生时间倒序 + 事件主键倒序，不采纳客户端排序', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listEvents({ organizationId: null, pagination: pagination() });

    expect(firstFindArgs(repository).order).toEqual({ createdAt: 'DESC', eventId: 'DESC' });
  });

  it('OFFSET 偏移按页码计算', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([]);
    repository.count.mockResolvedValue(0);

    await service.listEvents({
      organizationId: null,
      pagination: pagination({ page: 3, pageSize: 20 }),
    });

    const args = firstFindArgs(repository);
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
  });

  it('withTotal 为真时用同一 WHERE 统计；为假时不发统计查询', async () => {
    const withTotalService = createService();
    withTotalService.repository.find.mockResolvedValue([makeEntity()]);
    withTotalService.repository.count.mockResolvedValue(7);

    const page = await withTotalService.service.listEvents({
      organizationId: null,
      pagination: pagination({ withTotal: true }),
    });

    expect(page.total).toBe(7);
    expect(withTotalService.repository.count).toHaveBeenCalledTimes(1);
    expect(withTotalService.repository.count.mock.calls[0][0].where).toEqual(
      firstFindArgs(withTotalService.repository).where,
    );

    const withoutTotalService = createService();
    withoutTotalService.repository.find.mockResolvedValue([makeEntity()]);

    const withoutTotal = await withoutTotalService.service.listEvents({
      organizationId: null,
      pagination: pagination({ withTotal: false }),
    });

    expect(withoutTotal.total).toBe(0);
    expect(withoutTotalService.repository.count).not.toHaveBeenCalled();
  });

  it('detail 原值不外泄：只返回白名单摘要', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([makeEntity()]);
    repository.count.mockResolvedValue(1);

    const page = await service.listEvents({ organizationId: null, pagination: pagination() });

    expect(page.items[0].detail).toEqual({ reason: '重复上传' });
    expect(JSON.stringify(page.items[0])).not.toContain('contentMd');
    expect(JSON.stringify(page.items[0])).not.toContain('正文');
  });

  it('历史自由文本 detail 投影为空，不报错也不透传', async () => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([makeEntity({ detail: '管理员删除了资料 doc-1001' })]);
    repository.count.mockResolvedValue(1);

    const page = await service.listEvents({ organizationId: null, pagination: pagination() });

    expect(page.items[0].detail).toBeNull();
  });

  it.each([
    ['operation', { operation: 'MANAGE_ACCOUNT' }],
    ['operation', { operation: 'RESET_LEVEL2_CREDENTIAL' }],
    ['result', { result: 'UNKNOWN' }],
  ])('存储事实越出白名单时失败关闭（%s=%o）', async (_field, override) => {
    const { service, repository } = createService();
    repository.find.mockResolvedValue([makeEntity(override)]);
    repository.count.mockResolvedValue(1);

    await expect(
      service.listEvents({ organizationId: null, pagination: pagination() }),
    ).rejects.toMatchObject({ code: MANAGEMENT_AUDIT_ERROR.READ_FAILED });
  });
});
