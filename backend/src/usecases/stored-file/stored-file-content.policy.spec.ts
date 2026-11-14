// src/usecases/stored-file/stored-file-content.policy.spec.ts

/// <reference types="jest" />
import {
  extractStoredFileExtension,
  resolveVerifiedStoredFileMimeType,
} from './stored-file-content.policy';

const allowedMimeTypes = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
  'text/csv',
];

describe('stored-file-content.policy', () => {
  it('提取小写扩展名', () => {
    expect(extractStoredFileExtension('维修记录.PDF')).toBe('pdf');
    expect(extractStoredFileExtension('无扩展名')).toBe('');
  });

  it('按实际内容识别 PDF/PNG/JPEG/ZIP 容器/OLE 容器', () => {
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from('%PDF-1.7\n...', 'ascii'),
        originalFilename: 'a.pdf',
        allowedMimeTypes,
      }),
    ).toBe('application/pdf');

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        originalFilename: 'a.png',
        allowedMimeTypes,
      }),
    ).toBe('image/png');

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        originalFilename: 'a.jpg',
        allowedMimeTypes,
      }),
    ).toBe('image/jpeg');

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
        originalFilename: 'a.docx',
        allowedMimeTypes,
      }),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        originalFilename: 'a.doc',
        allowedMimeTypes,
      }),
    ).toBe('application/msword');
  });

  it('UTF-8 文本通过；带 NUL 或非法 UTF-8 的二进制冒充文本被拒绝', () => {
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from('维修过程：更换光源\n', 'utf8'),
        originalFilename: '记录.txt',
        allowedMimeTypes,
      }),
    ).toBe('text/plain');

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0x61, 0x00, 0x62]),
        originalFilename: 'record.txt',
        allowedMimeTypes,
      }),
    ).toBeNull();

    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0xff, 0xfe, 0xfd]),
        originalFilename: 'record.csv',
        allowedMimeTypes,
      }),
    ).toBeNull();
  });

  it('实际内容与扩展名不符被拒绝', () => {
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from('not-a-pdf'),
        originalFilename: 'fake.pdf',
        allowedMimeTypes,
      }),
    ).toBeNull();
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        originalFilename: 'fake.txt',
        allowedMimeTypes,
      }),
    ).toBeNull();
  });

  it('扩展名未知或 MIME 不在服务端白名单时被拒绝', () => {
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from('%PDF-1.7'),
        originalFilename: 'a.exe',
        allowedMimeTypes,
      }),
    ).toBeNull();
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.from('%PDF-1.7'),
        originalFilename: 'a.pdf',
        allowedMimeTypes: [],
      }),
    ).toBeNull();
  });

  it('空内容返回 null', () => {
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: Buffer.alloc(0),
        originalFilename: 'a.pdf',
        allowedMimeTypes,
      }),
    ).toBeNull();
  });
});
