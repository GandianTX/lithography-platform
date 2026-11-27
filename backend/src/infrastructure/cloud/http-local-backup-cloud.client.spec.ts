// src/infrastructure/cloud/http-local-backup-cloud.client.spec.ts
/**
 * 云备份 HTTP 客户端的定向测试（任务 09 第 10 项 D11）。
 *
 * 守住四条：
 * 1. **未配置即失败关闭**（地址或凭据缺失 ⇒ 端口不注册、调用不发生）；
 * 2. **受控失败码**：2xx 形态非法／4xx／5xx／网络异常／超时各有各的码，
 *    且**不携带**地址、凭据与正文；
 * 3. **用途固定为云备份**：出站头 `x-cloud-purpose: CLOUD_BACKUP`，
 *    绝不与业务同步凭据混用；
 * 4. **只拼本模块内的固定相对路径**：不接受外部任意 URL。
 */
import axios from 'axios';

import {
  CLOUD_FAILURE_CODES,
  HttpLocalBackupCloudClient,
  resolveNetworkFailureCode,
} from './http-local-backup-cloud.client';

const BASE_URL = 'https://cloud.example.com/api';

function buildClient(
  overrides: { baseUrl?: string | null; credential?: string | null } = {},
): HttpLocalBackupCloudClient {
  return new HttpLocalBackupCloudClient(
    {
      baseUrl: overrides.baseUrl === undefined ? BASE_URL : overrides.baseUrl,
      credential: overrides.credential === undefined ? 'cred-1' : overrides.credential,
      timeoutMs: 5_000,
      maxUploadFileBytes: 1024,
      maxUploadPackageBytes: 4096,
    },
    { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as never,
  );
}

describe('云备份 HTTP 客户端', () => {
  it('地址与凭据都齐备才算已配置', () => {
    expect(buildClient().configured).toBe(true);
    expect(buildClient({ baseUrl: null }).configured).toBe(false);
    expect(buildClient({ credential: null }).configured).toBe(false);
  });

  it('拼接地址时只认本模块内的固定相对路径', () => {
    const client = buildClient();
    expect(client.buildUrl('/backup-packages')).toBe(`${BASE_URL}/backup-packages`);
    expect(client.buildUrl('backup-packages')).toBe(`${BASE_URL}/backup-packages`);
    // 末尾斜杠不产生双斜杠
    const trailing = buildClient({ baseUrl: 'https://cloud.example.com/api/' });
    expect(trailing.buildUrl('/backup-packages')).toBe(`${BASE_URL}/backup-packages`);
  });

  it('未配置地址时拼接地址即失败', () => {
    expect(() => buildClient({ baseUrl: null }).buildUrl('/backup-packages')).toThrow();
  });

  it('出站头带凭据与固定的云备份用途（不与业务同步混用）', () => {
    const headers = buildClient().headers();
    expect(headers['authorization']).toBe('Bearer cred-1');
    expect(headers['x-cloud-purpose']).toBe('CLOUD_BACKUP');
    expect(Object.keys(headers).sort()).toEqual(['authorization', 'x-cloud-purpose']);
  });

  it('未配置凭据时取请求头即失败', () => {
    expect(() => buildClient({ credential: null }).headers()).toThrow();
  });

  it('2xx 且形态合法 ⇒ 成功', async () => {
    const client = buildClient();
    const result = await client.call(
      () => Promise.resolve({ status: 200, data: { ok: true } }),
      (data) => data as { ok: boolean },
    );
    expect(result).toEqual({ ok: true, value: { ok: true } });
  });

  it('2xx 但形态非法 ⇒ 受控"响应非法"（不把非法值透传）', async () => {
    const client = buildClient();
    const result = await client.call(
      () => Promise.resolve({ status: 200, data: { unexpected: true } }),
      () => null,
    );
    expect(result).toEqual({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_INVALID_RESPONSE });
  });

  it('4xx ⇒ 受控"被拒绝"；5xx ⇒ 受控"服务端异常"', async () => {
    const client = buildClient();
    const rejected = await client.call(
      () => Promise.resolve({ status: 400, data: null }),
      (data) => data,
    );
    expect(rejected).toEqual({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_REJECTED });
    const failed = await client.call(
      () => Promise.resolve({ status: 503, data: null }),
      (data) => data,
    );
    expect(failed).toEqual({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_SERVER_ERROR });
  });

  it('axios 默认把非 2xx 变成 reject ⇒ catch 分支必须按 response.status 区分 4xx／5xx', async () => {
    const client = buildClient();
    // axios 的真实行为：非 2xx 直接 reject，错误对象带 response.status。
    // 此前客户端只看 error.code ⇒ 4xx/5xx 全被报成"云端不可达"（生产路径不可达的死码）。
    const rejected = await client.call(
      () =>
        Promise.reject(
          Object.assign(new Error('Request failed with status code 422'), {
            code: 'ERR_BAD_REQUEST',
            response: { status: 422, data: null },
          }),
        ),
      (data) => data,
    );
    expect(rejected).toMatchObject({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_REJECTED });

    const failed = await client.call(
      () =>
        Promise.reject(
          Object.assign(new Error('Request failed with status code 502'), {
            code: 'ERR_BAD_RESPONSE',
            response: { status: 502, data: null },
          }),
        ),
      (data) => data,
    );
    expect(failed).toMatchObject({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_SERVER_ERROR });
  });

  it('不覆盖 axios 的 validateStatus（非 2xx 必然走 reject 分支，由状态码映射兜住）', () => {
    // 与 axios 默认实现同一个函数 ⇒ 本客户端没有把非 2xx 变成"正常响应"
    expect(buildClient().http.defaults.validateStatus).toBe(axios.defaults.validateStatus);
  });

  it('网络异常 ⇒ 受控"不可达"；超时 ⇒ 受控"超时"', async () => {
    const client = buildClient();
    const unreachable = await client.call(
      () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
      (data) => data,
    );
    expect(unreachable).toMatchObject({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE });
    const timeout = await client.call(
      () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })),
      (data) => data,
    );
    expect(timeout).toMatchObject({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_TIMEOUT });
  });

  it('未配置 ⇒ 调用即失败关闭（连请求都不该发出）', async () => {
    const run = jest.fn();
    const result = await buildClient({ baseUrl: null }).call(run, (data) => data);
    expect(result).toEqual({ ok: false, code: CLOUD_FAILURE_CODES.CLOUD_NOT_CONFIGURED });
    expect(run).not.toHaveBeenCalled();
  });

  it('网络类异常的受控码映射：只认超时与其它', () => {
    expect(resolveNetworkFailureCode({ code: 'ECONNABORTED' })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_TIMEOUT,
    );
    expect(resolveNetworkFailureCode({ code: 'ETIMEDOUT' })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_TIMEOUT,
    );
    expect(resolveNetworkFailureCode({ code: 'ECONNREFUSED' })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE,
    );
    expect(resolveNetworkFailureCode({})).toBe(CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE);
    // 带 response.status 时按状态码分类（axios 非 2xx reject 的真实形态）
    expect(resolveNetworkFailureCode({ code: 'ERR_BAD_REQUEST', response: { status: 400 } })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_REJECTED,
    );
    expect(resolveNetworkFailureCode({ code: 'ERR_BAD_RESPONSE', response: { status: 503 } })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_SERVER_ERROR,
    );
    // 状态码缺失时退回"不可达"
    expect(resolveNetworkFailureCode({ code: 'ERR_BAD_REQUEST' })).toBe(
      CLOUD_FAILURE_CODES.CLOUD_UNREACHABLE,
    );
  });
});
