/// <reference types="jest" />
import { SYNC_ERROR } from '@core/common/errors/domain-error';
import { readConflictSnapshotBody, readOptionalStringField } from './sync-conflict-snapshot.policy';

/**
 * 冲突快照契约读取（任务 09 R067／R068）。
 *
 * 守住**真实登记形态**（信封＋`body`）与旧契约（信封根）都能取到受控字段；
 * 结构版本不符／非法 JSON／非对象／`body` 类型非法 ⇒ 失败关闭。
 */
describe('readConflictSnapshotBody（冲突快照契约读取）', () => {
  it('真实登记形态：信封 ＋ body 能取到正文载荷', () => {
    const read = readConflictSnapshotBody(
      JSON.stringify({
        schema_version: 1,
        resource_type: 'REPAIR_REQUEST',
        record_uuid: 'record-uuid-1',
        version_no: 4,
        manifest_checksum: 'checksum',
        body: { schema_version: 1, content_md: '# 本地正文' },
      }),
    );

    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') {
      return;
    }
    expect(read.body['content_md']).toBe('# 本地正文');
  });

  it('旧契约：受控字段挂在信封根上同样可读', () => {
    const read = readConflictSnapshotBody(
      JSON.stringify({ schema_version: 1, content_md: '# 本地正文' }),
    );

    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') {
      return;
    }
    expect(read.body['content_md']).toBe('# 本地正文');
  });

  it('非法 JSON：失败关闭', () => {
    const read = readConflictSnapshotBody('not-json');

    expect(read.kind).toBe('reject');
    if (read.kind !== 'reject') {
      return;
    }
    expect(read.code).toBe(SYNC_ERROR.LOCAL_RESOLUTION_SNAPSHOT_INVALID);
  });

  it('不是 JSON 对象：失败关闭', () => {
    expect(readConflictSnapshotBody('[]').kind).toBe('reject');
    expect(readConflictSnapshotBody('"x"').kind).toBe('reject');
  });

  it('结构版本不符：失败关闭（不猜字段含义）', () => {
    const read = readConflictSnapshotBody(JSON.stringify({ schema_version: 2, body: {} }));

    expect(read.kind).toBe('reject');
  });

  it('body 存在但不是对象：失败关闭', () => {
    const read = readConflictSnapshotBody(JSON.stringify({ schema_version: 1, body: 'oops' }));

    expect(read.kind).toBe('reject');
  });

  it('可指定拒绝时的错误码（保留本地／使用云端各有自己的码）', () => {
    const read = readConflictSnapshotBody('not-json', {
      invalidCode: SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID,
    });

    expect(read.kind).toBe('reject');
    if (read.kind !== 'reject') {
      return;
    }
    expect(read.code).toBe(SYNC_ERROR.CLOUD_ALIGNMENT_SNAPSHOT_INVALID);
  });
});

describe('readOptionalStringField（可选字符串字段读取）', () => {
  it('缺省与 null 按"没有该字段"处理', () => {
    expect(readOptionalStringField({}, 'content_md').kind).toBe('absent');
    expect(readOptionalStringField({ content_md: null }, 'content_md').kind).toBe('absent');
  });

  it('类型非法必须被发现（当成"没有"会让裁决丢掉正文）', () => {
    expect(readOptionalStringField({ content_md: 123 }, 'content_md').kind).toBe('invalid');
  });

  it('字符串给出取值', () => {
    const read = readOptionalStringField({ content_md: '# 正文' }, 'content_md');

    expect(read).toEqual({ kind: 'value', value: '# 正文' });
  });
});
