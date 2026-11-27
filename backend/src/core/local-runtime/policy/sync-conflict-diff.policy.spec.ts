/// <reference types="jest" />
import { computeSyncConflictDiff } from './sync-conflict-diff.policy';

describe('冲突差异计算（S2.3）', () => {
  it('相同快照没有差异', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ schema_version: 1, content_md: '同样的内容' }),
      cloudSnapshot: JSON.stringify({ schema_version: 1, content_md: '同样的内容' }),
    });

    expect(result.entries).toEqual([]);
    expect(result.invalid).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('字段值不同 → DIFFERENT，并给出两侧展示值', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ schema_version: 1, content_md: '本地版本' }),
      cloudSnapshot: JSON.stringify({ schema_version: 1, content_md: '云端版本' }),
    });

    expect(result.entries).toEqual([
      { path: 'content_md', kind: 'DIFFERENT', localValue: '本地版本', cloudValue: '云端版本' },
    ]);
  });

  it('单侧字段 → ONLY_LOCAL／ONLY_CLOUD', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ schema_version: 1, only_local: 'x' }),
      cloudSnapshot: JSON.stringify({ schema_version: 1, only_cloud: 'y' }),
    });

    expect(result.entries).toEqual([
      { path: 'only_cloud', kind: 'ONLY_CLOUD', localValue: null, cloudValue: 'y' },
      { path: 'only_local', kind: 'ONLY_LOCAL', localValue: 'x', cloudValue: null },
    ]);
  });

  it('嵌套对象与数组按下标展开', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ files: [{ name: 'a.pdf' }] }),
      cloudSnapshot: JSON.stringify({ files: [{ name: 'b.pdf' }] }),
    });

    expect(result.entries).toEqual([
      { path: 'files.0.name', kind: 'DIFFERENT', localValue: 'a.pdf', cloudValue: 'b.pdf' },
    ]);
  });

  it('键顺序不同不算差异', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ a: 1, b: 2 }),
      cloudSnapshot: JSON.stringify({ b: 2, a: 1 }),
    });

    expect(result.entries).toEqual([]);
  });

  it('快照无法解析时如实标记"无法比较"，不猜内容', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: 'not-json',
      cloudSnapshot: JSON.stringify({ a: 1 }),
    });

    expect(result.invalid).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('条目超上限时截断并如实标记', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ a: 1, b: 2, c: 3 }),
      cloudSnapshot: JSON.stringify({ a: 9, b: 9, c: 9 }),
      maxEntries: 2,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('长展示值被截断，不把整段正文塞进列表', () => {
    const result = computeSyncConflictDiff({
      localSnapshot: JSON.stringify({ content_md: 'x'.repeat(50) }),
      cloudSnapshot: JSON.stringify({ content_md: 'y'.repeat(50) }),
      maxValueLength: 10,
    });

    expect(result.entries[0].localValue).toBe(`${'x'.repeat(10)}…`);
  });
});
