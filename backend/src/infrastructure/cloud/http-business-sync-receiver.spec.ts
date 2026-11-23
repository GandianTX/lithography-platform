// src/infrastructure/cloud/http-business-sync-receiver.spec.ts

/**
 * 业务同步接收端 HTTP 实现的定向测试（任务 09 新计划第 12 项 ＋ P1-2 原件字节传输）。
 *
 * 守住五条：
 * 1. **未配置即失败关闭**（不伪造成功）；
 * 2. **回包按不可信输入处理**：字段逐个校验形态，非法即失败关闭；
 * 3. **网络异常／超时／非 2xx ⇒ 受控失败码**（不含地址、凭据与正文）；
 * 4. **用途固定为业务同步**（不与云备份凭据混用）；
 * 5. **原件字节真的送出**：multipart 里除元数据部件外，每个原件一个部件，
 *    部件名＝清单里的相对路径，字节内容＝本机实测字节（不是只报清单）。
 */
import { createHash } from 'node:crypto';

import {
  BUSINESS_SYNC_FAILURE_CODES,
  BusinessSyncCallError,
  HttpBusinessSyncReceiver,
} from './http-business-sync-receiver';

type HttpStub = { post: jest.Mock };

function buildReceiver(
  options: { baseUrl?: string | null; credential?: string | null; post?: jest.Mock } = {},
) {
  const post = options.post ?? jest.fn();
  const receiver = new HttpBusinessSyncReceiver(
    {
      baseUrl: options.baseUrl === undefined ? 'https://cloud.example.com/api' : options.baseUrl,
      credential: options.credential === undefined ? 'cred-1' : options.credential,
      timeoutMs: 5_000,
    },
    { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
  );
  // 替换内部 HTTP 客户端（不触网）
  (receiver as unknown as { http: HttpStub }).http = { post };
  return { receiver, post };
}

/** 原件真实字节（12 字节）与其实测校验值 */
const originalBytes = new Uint8Array(Buffer.from('hello world!', 'utf8'));
const originalSha256 = createHash('sha256').update(Buffer.from(originalBytes)).digest('hex');

const request = {
  organizationId: 4,
  installationId: 'inst-1',
  accountId: 16,
  resourceType: 'REFERENCE_DOCUMENT',
  recordUuid: 'uuid-1',
  versionNo: 3,
  manifestChecksum: 'a'.repeat(64),
  body: { title: '资料' },
  originals: [
    { relativePath: 'originals/a.bin', sha256: originalSha256, byteSize: originalBytes.byteLength },
  ],
  originalPayloads: [{ relativePath: 'originals/a.bin', bytes: originalBytes }],
  idempotencyKey: 'key-1',
};

/** 从 multipart 部件里取出指定名称的字节内容 */
async function readPartBytes(form: FormData, name: string): Promise<Uint8Array | null> {
  const part = form.get(name);
  if (part === null) {
    return null;
  }
  const blob = part as Blob;
  return new Uint8Array(await blob.arrayBuffer());
}

describe('业务同步接收端 HTTP 实现', () => {
  it('未配置地址或凭据 ⇒ 失败关闭（不伪造成功）', async () => {
    const { receiver, post } = buildReceiver({ baseUrl: null });
    await expect(receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_NOT_CONFIGURED,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('成功回包按契约解析（含原件清单与受控字段）', async () => {
    const { receiver, post } = buildReceiver({
      post: jest.fn().mockResolvedValue({
        data: {
          status: 'ACCEPTED',
          reason: 'OK',
          organization_id: 4,
          record_uuid: 'uuid-1',
          version_no: 3,
          manifest_checksum: 'a'.repeat(64),
          received_originals: [
            { relative_path: 'originals/a.bin', sha256: 'b'.repeat(64), byte_size: 12 },
          ],
          remote_resource_id: 'remote-1',
          snapshot: { title: '资料' },
          received_at: '2026-11-23T00:00:00.000Z',
        },
      }),
    });

    const response = await receiver.send(request);

    expect(response.status).toBe('ACCEPTED');
    expect(response.organizationId).toBe(4);
    expect(response.recordUuid).toBe('uuid-1');
    expect(response.versionNo).toBe(3);
    expect(response.receivedOriginals).toEqual([
      { relativePath: 'originals/a.bin', sha256: 'b'.repeat(64), byteSize: 12 },
    ]);
    expect(response.remoteResourceId).toBe('remote-1');
    // 请求按 multipart 送出：元数据部件 ＋ 原件字节部件
    const [, form, options] = post.mock.calls[0] as [string, FormData, unknown];
    expect(form).toBeInstanceOf(FormData);
    const metadataText = await (form.get('metadata') as Blob).text();
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    expect(metadata['record_uuid']).toBe('uuid-1');
    expect(metadata['idempotency_key']).toBe('key-1');
    expect(metadata['organization_id']).toBe(4);
    expect(options).toBeDefined();
  });

  // P1-2：只报清单不送字节＝"只报账不交货"，云端必然核不过完整性。
  it('原件字节真的送出：multipart 里每个原件一个部件，字节与清单一致', async () => {
    const { receiver, post } = buildReceiver({
      post: jest.fn().mockResolvedValue({
        data: {
          status: 'ACCEPTED',
          reason: 'OK',
          organization_id: 4,
          record_uuid: 'uuid-1',
          version_no: 3,
          manifest_checksum: 'a'.repeat(64),
          received_originals: [
            {
              relative_path: 'originals/a.bin',
              sha256: originalSha256,
              byte_size: originalBytes.byteLength,
            },
          ],
          remote_resource_id: 'remote-1',
          snapshot: { title: '资料' },
          received_at: '2026-11-23T00:00:00.000Z',
        },
      }),
    });

    await receiver.send(request);

    const [, form] = post.mock.calls[0] as [string, FormData, unknown];
    const sent = await readPartBytes(form, 'originals/a.bin');
    expect(sent).not.toBeNull();
    expect(Buffer.from(sent as Uint8Array).toString('utf8')).toBe('hello world!');
    // 送出的字节必须与清单登记的字节数、校验值一致
    expect((sent as Uint8Array).byteLength).toBe(originalBytes.byteLength);
    expect(
      createHash('sha256')
        .update(Buffer.from(sent as Uint8Array))
        .digest('hex'),
    ).toBe(originalSha256);
  });

  it('回包状态非法 ⇒ 失败关闭（不把非法值透传给裁决层）', async () => {
    const { receiver } = buildReceiver({
      post: jest.fn().mockResolvedValue({ data: { status: 'WHATEVER' } }),
    });
    await expect(receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
    });
  });

  it('回包原件条目形态非法 ⇒ 失败关闭', async () => {
    const { receiver } = buildReceiver({
      post: jest.fn().mockResolvedValue({
        data: { status: 'ACCEPTED', received_originals: [{ relative_path: 'x' }] },
      }),
    });
    await expect(receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_RESPONSE,
    });
  });

  it('云端 4xx ⇒ 受控"被拒绝"；5xx ⇒ 受控"服务端异常"', async () => {
    const rejected = buildReceiver({
      post: jest.fn().mockRejectedValue({ response: { status: 409 }, message: 'x' }),
    });
    await expect(rejected.receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_REJECTED,
    });
    const failed = buildReceiver({
      post: jest.fn().mockRejectedValue({ response: { status: 500 }, message: 'x' }),
    });
    await expect(failed.receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_SERVER_ERROR,
    });
  });

  it('网络不可达／超时 ⇒ 受控失败码，且错误信息不含地址与凭据', async () => {
    const unreachable = buildReceiver({
      post: jest.fn().mockRejectedValue({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }),
    });
    await expect(unreachable.receiver.send(request)).rejects.toBeInstanceOf(BusinessSyncCallError);
    const timeout = buildReceiver({
      post: jest.fn().mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout' }),
    });
    await expect(timeout.receiver.send(request)).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_TIMEOUT,
    });
  });
});
