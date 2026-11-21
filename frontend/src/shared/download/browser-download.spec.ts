// src/features/reference-document/infrastructure/browser-file-download-adapter.spec.ts

/**
 * 浏览器文件保存适配单测（P3-3）：正常路径与 `click()` 抛错路径都必须回收。
 *
 * 缺陷事实（Codex 复查）：原实现只在正常路径 `remove()` + `revokeObjectURL`，
 * `anchor.click()` 抛错会留下游离的 `<a>` 节点与永不释放的 blob URL，
 * 「短命 URL 不外泄」的承诺在该分支失效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base64ToBlob, saveBlobAsFile } from './browser-download';

const createObjectURL = vi.fn(() => 'blob:mock-url');
const revokeObjectURL = vi.fn();

/** jsdom 未实现 createObjectURL / revokeObjectURL：按真实签名打桩 */
function stubObjectUrlApi() {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
}

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  stubObjectUrlApi();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveBlobAsFile', () => {
  it('正常路径：临时 <a> 点击后立即移除，blob URL 被撤销', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = new Blob(['payload'], { type: 'text/plain' });

    saveBlobAsFile(blob, '参考资料.txt');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;

    expect(anchor.download).toBe('参考资料.txt');
    expect(anchor.href).toContain('blob:mock-url');
    // 下载节点不得残留
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('click() 抛错：仍移除临时节点并撤销 blob URL，错误继续上抛', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click boom');
    });

    expect(() => saveBlobAsFile(new Blob(['payload']), 'a.txt')).toThrow('click boom');

    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

describe('base64ToBlob', () => {
  it('把 Base64 文本还原为字节并带上 MIME 类型', () => {
    const blob = base64ToBlob(btoa('PDF-CONTENT'), 'application/pdf');

    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe('PDF-CONTENT'.length);
  });

  it('空内容返回空 Blob（不抛错）', () => {
    const blob = base64ToBlob('', 'application/pdf');

    expect(blob.size).toBe(0);
  });
});
