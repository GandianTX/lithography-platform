// src/infrastructure/cloud/http-business-sync-receiver.real-http.spec.ts

/**
 * 业务同步原件字节的**真实 HTTP 端到端**验证（任务 09 P1-2 收口）。
 *
 * 为什么必须是"真实 HTTP"：本仓此前的验证都停在内存替身
 * （`http-business-sync-receiver.spec.ts` 把 axios 替掉，只断言 FormData 的形状），
 * 那只能证明"我们打算送什么"，**不能证明"云端确实收到了字节"**。
 * 本文件起一个**受控的一次性本地 HTTP 服务**（127.0.0.1 临时端口，
 * 进程内、随用例结束即销毁、不碰任何真实云端与凭据），
 * 让发送端真的走一次 HTTP，接收端**按收到的字节自己算 SHA-256**，
 * 再与本机送出的字节逐字节比对。
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BusinessSyncDispatchRequest } from '@core/local-runtime/policy/business-sync-protocol.policy';

import {
  BUSINESS_SYNC_FAILURE_CODES,
  HttpBusinessSyncReceiver,
} from './http-business-sync-receiver';

type MultipartPart = {
  name: string;
  filename: string | null;
  contentType: string | null;
  body: Buffer;
};

/**
 * 最小 multipart 解析（只解析本仓发送端产出的规范形态；不引入新依赖）。
 */
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length;
    if (body.slice(afterDelimiter, afterDelimiter + 2).toString('utf8') === '--') {
      break; // 结束标记
    }
    const headerStart = afterDelimiter + 2; // 跳过 CRLF
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) {
      break;
    }
    const headerText = body.slice(headerStart, headerEnd).toString('utf8');
    const nextDelimiter = body.indexOf(delimiter, headerEnd);
    const contentEnd = nextDelimiter === -1 ? body.length : nextDelimiter - 2;
    const content = body.slice(headerEnd + 4, contentEnd);

    let name = '';
    let filename: string | null = null;
    let contentType: string | null = null;
    for (const line of headerText.split('\r\n')) {
      const [rawKey, ...rest] = line.split(':');
      const key = (rawKey ?? '').trim().toLowerCase();
      const value = rest.join(':').trim();
      if (key === 'content-disposition') {
        name = /name="([^"]*)"/.exec(value)?.[1] ?? '';
        filename = /filename="([^"]*)"/.exec(value)?.[1] ?? null;
      } else if (key === 'content-type') {
        contentType = value;
      }
    }
    parts.push({ name, filename, contentType, body: content });
    cursor = nextDelimiter;
  }
  return parts;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('业务同步原件字节的真实 HTTP 端到端', () => {
  let server: http.Server;
  let baseUrl: string;
  let respond: (parts: MultipartPart[]) => { status: number; payload: unknown };
  let receivedParts: MultipartPart[] = [];
  let receivedHeaders: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedHeaders = req.headers;
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
        const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
        receivedParts = boundary === '' ? [] : parseMultipart(raw, boundary);
        const result = respond(receivedParts);
        res.writeHead(result.status, { ['Content-Type']: 'application/json' });
        res.end(JSON.stringify(result.payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    receivedParts = [];
    receivedHeaders = {};
  });

  const buildReceiver = () =>
    new HttpBusinessSyncReceiver({ baseUrl, credential: 'cred-real-http', timeoutMs: 5_000 }, {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
    } as never);

  /** 从收到的元数据部件解析出本机送出的稳定事实 */
  const readMetadata = (): Record<string, unknown> =>
    JSON.parse(
      receivedParts.find((part) => part.name === 'metadata')?.body.toString('utf8') ?? '{}',
    ) as Record<string, unknown>;

  const baseRequest = (
    overrides: Partial<BusinessSyncDispatchRequest> = {},
  ): BusinessSyncDispatchRequest => ({
    organizationId: 4,
    installationId: 'inst-1',
    accountId: 16,
    resourceType: 'REFERENCE_DOCUMENT',
    recordUuid: 'uuid-real',
    versionNo: 3,
    manifestChecksum: 'c'.repeat(64),
    body: { title: '资料' },
    originals: [],
    originalPayloads: [],
    idempotencyKey: 'key-real',
    ...overrides,
  });

  it('云端确实收到原件字节：按实收字节算出的摘要与本机一致', async () => {
    const originalBytes = Buffer.from('原件真实字节-abc', 'utf8');
    respond = (parts) => {
      const original = parts.find((part) => part.name === 'originals/a.bin');
      const metadata = JSON.parse(
        parts.find((part) => part.name === 'metadata')?.body.toString('utf8') ?? '{}',
      ) as Record<string, unknown>;
      return {
        status: 200,
        payload: {
          status: 'ACCEPTED',
          reason: 'OK',
          organization_id: metadata['organization_id'],
          record_uuid: metadata['record_uuid'],
          version_no: metadata['version_no'],
          manifest_checksum: metadata['manifest_checksum'],
          // 接收端**按实收字节**自己算摘要（不是照抄清单）
          received_originals: [
            {
              relative_path: 'originals/a.bin',
              sha256: original === undefined ? '' : sha256(original.body),
              byte_size: original?.body.byteLength ?? 0,
            },
          ],
          remote_resource_id: 'remote-real-1',
          snapshot: null,
          received_at: '2026-11-23T00:00:00.000Z',
        },
      };
    };

    const response = await buildReceiver().send(
      baseRequest({
        recordUuid: 'uuid-real-1',
        originals: [
          {
            relativePath: 'originals/a.bin',
            sha256: sha256(originalBytes),
            byteSize: originalBytes.byteLength,
          },
        ],
        originalPayloads: [
          { relativePath: 'originals/a.bin', bytes: new Uint8Array(originalBytes) },
        ],
        idempotencyKey: 'key-real-1',
      }),
    );

    // 云端实收字节与本机送出的字节逐字节一致
    const receivedOriginal = receivedParts.find((part) => part.name === 'originals/a.bin');
    expect(receivedOriginal).toBeDefined();
    expect(receivedOriginal?.body.equals(originalBytes)).toBe(true);
    expect(sha256(receivedOriginal?.body ?? Buffer.alloc(0))).toBe(sha256(originalBytes));
    expect(response.status).toBe('ACCEPTED');
    expect(response.receivedOriginals).toEqual([
      {
        relativePath: 'originals/a.bin',
        sha256: sha256(originalBytes),
        byteSize: originalBytes.byteLength,
      },
    ]);
    expect(readMetadata()['record_uuid']).toBe('uuid-real-1');
    // 凭据确实送出（凭据不出现在错误信息里，见失败用例）
    expect(receivedHeaders['authorization']).toBe('Bearer cred-real-http');
  });

  it('同名附件：两件同名走不同相对路径，云端各自收到正确字节', async () => {
    const first = Buffer.from('同名附件-第一件', 'utf8');
    const second = Buffer.from('同名附件-第二件-内容不同', 'utf8');
    respond = (parts) => {
      const metadata = JSON.parse(
        parts.find((part) => part.name === 'metadata')?.body.toString('utf8') ?? '{}',
      ) as Record<string, unknown>;
      return {
        status: 200,
        payload: {
          status: 'ACCEPTED',
          reason: 'OK',
          organization_id: metadata['organization_id'],
          record_uuid: metadata['record_uuid'],
          version_no: metadata['version_no'],
          manifest_checksum: metadata['manifest_checksum'],
          received_originals: parts
            .filter((part) => part.name.startsWith('originals/'))
            .map((part) => ({
              relative_path: part.name,
              sha256: sha256(part.body),
              byte_size: part.body.byteLength,
            })),
          remote_resource_id: 'remote-real-2',
          snapshot: null,
          received_at: '2026-11-23T00:00:00.000Z',
        },
      };
    };

    const response = await buildReceiver().send(
      baseRequest({
        resourceType: 'MAINTENANCE_REPORT',
        recordUuid: 'uuid-real-2',
        originals: [
          {
            relativePath: 'originals/report.pdf',
            sha256: sha256(first),
            byteSize: first.byteLength,
          },
          {
            relativePath: 'originals/report-2.pdf',
            sha256: sha256(second),
            byteSize: second.byteLength,
          },
        ],
        originalPayloads: [
          { relativePath: 'originals/report.pdf', bytes: new Uint8Array(first) },
          { relativePath: 'originals/report-2.pdf', bytes: new Uint8Array(second) },
        ],
        idempotencyKey: 'key-real-2',
      }),
    );

    expect(receivedParts.map((part) => part.name).sort()).toEqual([
      'metadata',
      'originals/report-2.pdf',
      'originals/report.pdf',
    ]);
    expect(
      receivedParts.find((part) => part.name === 'originals/report.pdf')?.body.equals(first),
    ).toBe(true);
    expect(
      receivedParts.find((part) => part.name === 'originals/report-2.pdf')?.body.equals(second),
    ).toBe(true);
    expect(response.receivedOriginals).toHaveLength(2);
  });

  it('云端明确拒绝：如实透出 REJECTED（不伪造成功）', async () => {
    respond = () => ({
      status: 200,
      payload: {
        status: 'REJECTED',
        reason: 'CLOUD_REJECTED',
        organization_id: 4,
        record_uuid: 'uuid-real-3',
        version_no: 3,
        manifest_checksum: 'e'.repeat(64),
        received_originals: [],
        remote_resource_id: null,
        snapshot: null,
        received_at: '2026-11-23T00:00:00.000Z',
      },
    });

    const response = await buildReceiver().send(
      baseRequest({ recordUuid: 'uuid-real-3', idempotencyKey: 'key-real-3' }),
    );

    expect(response.status).toBe('REJECTED');
  });

  it('云端 4xx（请求畸形／截断）⇒ 受控"被拒绝"失败码', async () => {
    respond = () => ({ status: 400, payload: { message: 'bad request' } });

    await expect(
      buildReceiver().send(baseRequest({ recordUuid: 'uuid-real-4' })),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_REJECTED });
  });

  it('云端 5xx ⇒ 受控"服务端异常"失败码', async () => {
    respond = () => ({ status: 500, payload: { message: 'oops' } });

    await expect(
      buildReceiver().send(baseRequest({ recordUuid: 'uuid-real-5' })),
    ).rejects.toMatchObject({ code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_SERVER_ERROR });
  });

  it('路径攻击：清单里的相对路径越界 ⇒ 发送端拒绝，请求根本没发出去', async () => {
    respond = () => ({ status: 200, payload: { status: 'ACCEPTED' } });
    const bytes = Buffer.from('x', 'utf8');

    await expect(
      buildReceiver().send(
        baseRequest({
          originals: [
            {
              relativePath: '../../etc/passwd',
              sha256: sha256(bytes),
              byteSize: bytes.byteLength,
            },
          ],
          originalPayloads: [{ relativePath: '../../etc/passwd', bytes: new Uint8Array(bytes) }],
        }),
      ),
    ).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
    });
    expect(receivedParts).toHaveLength(0);
  });

  it('同名附件路径重复 ⇒ 发送端拒绝（无法逐项对应）', async () => {
    respond = () => ({ status: 200, payload: { status: 'ACCEPTED' } });
    const first = Buffer.from('a', 'utf8');
    const second = Buffer.from('b', 'utf8');

    await expect(
      buildReceiver().send(
        baseRequest({
          originals: [
            { relativePath: 'originals/same.pdf', sha256: sha256(first), byteSize: 1 },
            { relativePath: 'originals/same.pdf', sha256: sha256(second), byteSize: 1 },
          ],
          originalPayloads: [
            { relativePath: 'originals/same.pdf', bytes: new Uint8Array(first) },
            { relativePath: 'originals/same.pdf', bytes: new Uint8Array(second) },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: BUSINESS_SYNC_FAILURE_CODES.BUSINESS_SYNC_INVALID_PAYLOAD,
    });
    expect(receivedParts).toHaveLength(0);
  });
});
