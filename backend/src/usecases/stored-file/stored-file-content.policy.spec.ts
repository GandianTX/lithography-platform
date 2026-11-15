// src/usecases/stored-file/stored-file-content.policy.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

import {
  buildCfbDifatChainTailFixture,
  buildCfbDirectoryChainTailFixture,
  type CfbChainTailFixture,
  makeMinimalPdf,
  minimalJpeg,
  minimalPng,
  officeSamples,
} from '../../../test/fixtures/stored-file-samples';
import {
  extractStoredFileExtension,
  resolveVerifiedStoredFileMimeType,
} from './stored-file-content.policy';

const allowedMimeTypes = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/markdown',
  'text/csv',
];

const resolve = (buffer: Buffer, originalFilename: string): string | null =>
  resolveVerifiedStoredFileMimeType({ buffer, originalFilename, allowedMimeTypes });

type ZipFixtureEntry = {
  name: string;
  data: Buffer;
  declaredUncompressedSize?: number;
  crcOverride?: number;
  compressionMethod?: number;
  localCompressionMethod?: number;
  compressedData?: Buffer;
  emitLocal?: boolean;
  localOffsetOverride?: number;
  centralCompressedSizeOverride?: number;
  dataDescriptor?: boolean;
  dataDescriptorSignature?: boolean;
  emitDataDescriptor?: boolean;
  descriptorTruncateBytes?: number;
  descriptorCrcOverride?: number;
  descriptorCompressedSizeOverride?: number;
  descriptorUncompressedSizeOverride?: number;
};

const zipLocalRecord = (entry: ZipFixtureEntry): Buffer => {
  const name = Buffer.from(entry.name, 'utf8');
  const payload = entry.compressedData ?? entry.data;
  const checksum = entry.crcOverride ?? crc32(entry.data);
  const declaredSize = entry.declaredUncompressedSize ?? entry.data.byteLength;
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(entry.dataDescriptor ? 0x08 : 0, 6);
  localHeader.writeUInt16LE(entry.localCompressionMethod ?? entry.compressionMethod ?? 0, 8);
  localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : checksum, 14);
  localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : payload.byteLength, 18);
  localHeader.writeUInt32LE(entry.dataDescriptor ? 0 : declaredSize, 22);
  localHeader.writeUInt16LE(name.byteLength, 26);
  if (!entry.dataDescriptor) {
    return Buffer.concat([localHeader, name, payload]);
  }
  if (entry.emitDataDescriptor === false) {
    return Buffer.concat([localHeader, name, payload]);
  }
  const hasSignature = entry.dataDescriptorSignature !== false;
  const descriptor = Buffer.alloc(hasSignature ? 16 : 12);
  if (hasSignature) {
    descriptor.writeUInt32LE(0x08074b50, 0);
  }
  const fieldsOffset = hasSignature ? 4 : 0;
  descriptor.writeUInt32LE(entry.descriptorCrcOverride ?? checksum, fieldsOffset);
  descriptor.writeUInt32LE(
    entry.descriptorCompressedSizeOverride ?? payload.byteLength,
    fieldsOffset + 4,
  );
  descriptor.writeUInt32LE(
    entry.descriptorUncompressedSizeOverride ?? declaredSize,
    fieldsOffset + 8,
  );
  const emitted =
    entry.descriptorTruncateBytes === undefined
      ? descriptor
      : descriptor.subarray(0, descriptor.byteLength - entry.descriptorTruncateBytes);
  return Buffer.concat([localHeader, name, payload, emitted]);
};

/** 测试用最小 ZIP 构造器，用于伪造容器/预算负例。 */
function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = entry.compressedData ?? entry.data;
    const checksum = entry.crcOverride ?? crc32(entry.data);
    const declaredSize = entry.declaredUncompressedSize ?? entry.data.byteLength;
    const localOffset = entry.localOffsetOverride ?? offset;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.dataDescriptor ? 0x08 : 0, 8);
    centralHeader.writeUInt16LE(entry.compressionMethod ?? 0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.centralCompressedSizeOverride ?? payload.byteLength, 20);
    centralHeader.writeUInt32LE(declaredSize, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, name);
    if (entry.emitLocal !== false) {
      const localRecord = zipLocalRecord(entry);
      localParts.push(localRecord);
      offset += localRecord.byteLength;
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.byteLength, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

const mainPartFor = (kind: 'word' | 'sheet' | 'presentation'): string =>
  kind === 'word'
    ? 'word/document.xml'
    : kind === 'sheet'
      ? 'xl/workbook.xml'
      : 'ppt/presentation.xml';

const mainRootFor = (kind: 'word' | 'sheet' | 'presentation'): string =>
  kind === 'word'
    ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:document>'
    : kind === 'sheet'
      ? '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></workbook>'
      : '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"></p:presentation>';

const mainContentTypeFor = (kind: 'word' | 'sheet' | 'presentation'): string =>
  kind === 'word'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : kind === 'sheet'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

const ooxmlPackage = (
  kind: 'word' | 'sheet' | 'presentation',
  overrides: { contentTypes?: string; rels?: string; main?: string } = {},
): Buffer => {
  const mainPart = mainPartFor(kind);
  const contentTypes =
    overrides.contentTypes ??
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/${mainPart}" ContentType="${mainContentTypeFor(kind)}"/>
</Types>`;
  const rels =
    overrides.rels ??
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>
</Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: mainPart, data: Buffer.from(overrides.main ?? mainRootFor(kind), 'utf8') },
  ]);
};

const prefixedOoxmlPackage = (kind: 'word' | 'sheet' | 'presentation'): Buffer => {
  const mainPart = mainPartFor(kind);
  return ooxmlPackage(kind, {
    contentTypes: `<?xml version="1.0" encoding="UTF-8"?>
<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types">
<ct:Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<ct:Default Extension="xml" ContentType="application/xml"/>
<ct:Override PartName="/${mainPart}" ContentType="${mainContentTypeFor(kind)}"/>
</ct:Types>`,
    rels: `<?xml version="1.0" encoding="UTF-8"?>
<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">
<r:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/>
</r:Relationships>`,
  });
};

const patchZipEntryCrc = (zip: Buffer, entryName: string, crc: number): Buffer => {
  const patched = Buffer.from(zip);
  const centralOffset = patched.readUInt32LE(patched.byteLength - 6);
  let cursor = centralOffset;
  for (let index = 0; index < patched.readUInt16LE(patched.byteLength - 12); index += 1) {
    const nameLength = patched.readUInt16LE(cursor + 28);
    const extraLength = patched.readUInt16LE(cursor + 30);
    const commentLength = patched.readUInt16LE(cursor + 32);
    const name = patched.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === entryName) {
      const localOffset = patched.readUInt32LE(cursor + 42);
      patched.writeUInt32LE(crc, localOffset + 14);
      patched.writeUInt32LE(crc, cursor + 16);
      return patched;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip entry not found: ${entryName}`);
};

const buildOverlappingZip = (): Buffer => {
  const contentTypes = ooxmlPackage('word');
  const bName = '[Content_Types].xml';
  const bData = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    'utf8',
  );
  const bLocal = zipLocalRecord({ name: bName, data: bData });
  const aName = 'extra.bin';
  const aPad = Buffer.from('overlap-pad', 'utf8');
  const bOffset = 30 + Buffer.byteLength(aName) + aPad.byteLength;
  const aData = Buffer.concat([aPad, bLocal, Buffer.from('tail', 'utf8')]);

  // 从合法包中取出 rels 与主部件，保证除重叠外其余结构可读
  const source = contentTypes;
  const centralOffset = source.readUInt32LE(source.byteLength - 6);
  let cursor = centralOffset;
  const parts: ZipFixtureEntry[] = [
    { name: aName, data: aData },
    { name: bName, data: bData, emitLocal: false, localOffsetOverride: bOffset },
  ];
  for (let index = 0; index < source.readUInt16LE(source.byteLength - 12); index += 1) {
    const nameLength = source.readUInt16LE(cursor + 28);
    const extraLength = source.readUInt16LE(cursor + 30);
    const commentLength = source.readUInt16LE(cursor + 32);
    const name = source.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localOffset = source.readUInt32LE(cursor + 42);
    const localNameLength = source.readUInt16LE(localOffset + 26);
    const localExtraLength = source.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressedSize = source.readUInt32LE(cursor + 20);
    if (name !== bName) {
      parts.push({ name, data: source.subarray(dataOffset, dataOffset + compressedSize) });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return buildZip(parts);
};

const buildDescriptorPackage = (
  overrides: Partial<
    Pick<
      ZipFixtureEntry,
      | 'dataDescriptorSignature'
      | 'emitDataDescriptor'
      | 'descriptorTruncateBytes'
      | 'descriptorCrcOverride'
      | 'descriptorCompressedSizeOverride'
      | 'descriptorUncompressedSizeOverride'
    >
  > = {},
  target: 'first' | 'last' = 'first',
): Buffer => {
  const mainPart = mainPartFor('word');
  const entries: ZipFixtureEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="${mainContentTypeFor('word')}"/></Types>`,
        'utf8',
      ),
      dataDescriptor: true,
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/></Relationships>`,
        'utf8',
      ),
    },
    { name: mainPart, data: Buffer.from(mainRootFor('word'), 'utf8') },
  ];
  Object.assign(
    entries[target === 'first' ? 0 : entries.length - 1],
    { dataDescriptor: true },
    overrides,
  );
  return buildZip(entries);
};

/** 4 字节数据的 CRC32 恰为数据描述符签名值 0x08074b50，用于无签名描述符歧义回归。 */
const descriptorSignatureCollisionPayload = Buffer.from([0xac, 0x0a, 0x7a, 0xd5]);

const buildUnsignedDescriptorCollidingWithSignature = (): {
  buffer: Buffer;
  data: Buffer;
  dataOffset: number;
  descriptorOffset: number;
  centralDirectoryOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  centralCrc: number;
} => {
  const mainPart = mainPartFor('word');
  const data = descriptorSignatureCollisionPayload;
  const entries: ZipFixtureEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${mainPart}" ContentType="${mainContentTypeFor('word')}"/></Types>`,
        'utf8',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPart}"/></Relationships>`,
        'utf8',
      ),
    },
    { name: mainPart, data: Buffer.from(mainRootFor('word'), 'utf8') },
    { name: 'word/media/extra.bin', data, dataDescriptor: true, dataDescriptorSignature: false },
  ];
  const buffer = buildZip(entries);
  const centralDirectoryOffset = buffer.readUInt32LE(buffer.byteLength - 6);
  let cursor = centralDirectoryOffset;
  let lastCentralRecordOffset = cursor;
  for (let index = 0; index < buffer.readUInt16LE(buffer.byteLength - 12); index += 1) {
    lastCentralRecordOffset = cursor;
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const localOffset = buffer.readUInt32LE(lastCentralRecordOffset + 42);
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const compressedSize = buffer.readUInt32LE(lastCentralRecordOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(lastCentralRecordOffset + 24);
  const centralCrc = buffer.readUInt32LE(lastCentralRecordOffset + 16);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  return {
    buffer,
    data,
    dataOffset,
    descriptorOffset: dataOffset + compressedSize,
    centralDirectoryOffset,
    compressedSize,
    uncompressedSize,
    centralCrc,
  };
};

type CfbFixtureParts = {
  sectorSize: number;
  miniStreamCutoff: number;
  firstMiniFatSector: number;
  fatSectorIds: number[];
  fat: number[];
  directory: Buffer;
};

const readCfbFixtureParts = (sample: Buffer): CfbFixtureParts => {
  const sectorSize = 1 << sample.readUInt16LE(30);
  const firstDirectorySector = sample.readUInt32LE(48);
  const fatSectorIds: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const id = sample.readUInt32LE(76 + index * 4);
    if (id !== 0xffffffff) fatSectorIds.push(id);
  }
  const fat: number[] = [];
  for (const id of fatSectorIds) {
    const offset = (id + 1) * sectorSize;
    for (let cursor = offset; cursor < offset + sectorSize; cursor += 4) {
      fat.push(sample.readUInt32LE(cursor));
    }
  }

  const directoryChunks: Buffer[] = [];
  let sector = firstDirectorySector;
  for (let steps = 0; sector !== 0xfffffffe && sector !== 0xffffffff && steps < 100; steps += 1) {
    const offset = (sector + 1) * sectorSize;
    directoryChunks.push(sample.subarray(offset, offset + sectorSize));
    sector = fat[sector];
  }

  return {
    sectorSize,
    miniStreamCutoff: sample.readUInt32LE(56),
    firstMiniFatSector: sample.readUInt32LE(60),
    fatSectorIds,
    fat,
    directory: Buffer.concat(directoryChunks),
  };
};

const findCfbStreamEntry = (
  parts: CfbFixtureParts,
  streamName: string,
): { startSector: number; size: number } => {
  for (let index = 0; index < Math.floor(parts.directory.byteLength / 128); index += 1) {
    const base = index * 128;
    const nameLength = parts.directory.readUInt16LE(base + 64);
    if (!nameLength) continue;
    const name = parts.directory.toString('utf16le', base, base + nameLength - 2);
    if (name.toLowerCase() !== streamName.toLowerCase()) continue;
    return {
      startSector: parts.directory.readUInt32LE(base + 116),
      size: parts.directory.readUInt32LE(base + 120),
    };
  }
  throw new Error(`cfb stream not found: ${streamName}`);
};

const readCfbSectorChain = (fat: readonly number[], startSector: number): number[] => {
  const sectors: number[] = [];
  let sector = startSector;
  while (sector !== 0xfffffffe && sector !== 0xffffffff && sectors.length < 10000) {
    sectors.push(sector);
    sector = fat[sector];
  }
  return sectors;
};

const readCfbMiniFat = (sample: Buffer, parts: CfbFixtureParts): number[] => {
  const entries: number[] = [];
  const offset = (parts.firstMiniFatSector + 1) * parts.sectorSize;
  for (let cursor = offset; cursor < offset + parts.sectorSize; cursor += 4) {
    entries.push(sample.readUInt32LE(cursor));
  }
  return entries;
};

const patchCfbFatSuccessor = (
  sample: Buffer,
  parts: CfbFixtureParts,
  sector: number,
  value: number,
): Buffer => {
  const patched = Buffer.from(sample);
  const entriesPerSector = parts.sectorSize / 4;
  const fatSectorId = parts.fatSectorIds[Math.floor(sector / entriesPerSector)];
  const offset = (fatSectorId + 1) * parts.sectorSize + (sector % entriesPerSector) * 4;
  patched.writeUInt32LE(value, offset);
  return patched;
};

const patchCfbMiniFatSuccessor = (
  sample: Buffer,
  parts: CfbFixtureParts,
  miniSector: number,
  value: number,
): Buffer => {
  const patched = Buffer.from(sample);
  const offset = (parts.firstMiniFatSector + 1) * parts.sectorSize + miniSector * 4;
  patched.writeUInt32LE(value, offset);
  return patched;
};

const patchCfbChainToSelf = (sample: Buffer, streamName: string): Buffer => {
  const parts = readCfbFixtureParts(sample);
  const entry = findCfbStreamEntry(parts, streamName);
  const patched = Buffer.from(sample);
  if (entry.size < parts.miniStreamCutoff) {
    const miniFatOffset = (parts.firstMiniFatSector + 1) * parts.sectorSize;
    patched.writeUInt32LE(entry.startSector, miniFatOffset + entry.startSector * 4);
  } else {
    const entriesPerSector = parts.sectorSize / 4;
    const fatSectorId = parts.fatSectorIds[Math.floor(entry.startSector / entriesPerSector)];
    const fatOffset =
      (fatSectorId + 1) * parts.sectorSize + (entry.startSector % entriesPerSector) * 4;
    patched.writeUInt32LE(entry.startSector, fatOffset);
  }
  return patched;
};

/** 正负样本只允许链尾 4 字节不同；否则无法证明负例命中的是链尾校验。 */
const expectOnlyChainTerminatorChanged = (
  legal: CfbChainTailFixture,
  illegal: CfbChainTailFixture,
): void => {
  expect(illegal.terminatorOffset).toBe(legal.terminatorOffset);
  expect(illegal.buffer.byteLength).toBe(legal.buffer.byteLength);
  const changedOffsets: number[] = [];
  for (let offset = 0; offset < legal.buffer.byteLength; offset += 1) {
    if (legal.buffer[offset] !== illegal.buffer[offset]) {
      changedOffsets.push(offset);
    }
  }
  expect(changedOffsets.length).toBeGreaterThan(0);
  expect(Math.min(...changedOffsets)).toBeGreaterThanOrEqual(legal.terminatorOffset);
  expect(Math.max(...changedOffsets)).toBeLessThan(legal.terminatorOffset + 4);
};

function patchJpegMarker(sample: Buffer, from: number, to: number): Buffer {
  const patched = Buffer.from(sample);
  const markerOffset = patched.indexOf(Buffer.from([0xff, from]));
  if (markerOffset < 0) {
    throw new Error('jpeg marker not found in fixture');
  }
  patched[markerOffset + 1] = to;
  return patched;
}

describe('stored-file-content.policy', () => {
  it('提取小写扩展名', () => {
    expect(extractStoredFileExtension('维修记录.PDF')).toBe('pdf');
    expect(extractStoredFileExtension('无扩展名')).toBe('');
  });

  it('六种 Office 格式的真实有效样本通过上传内容校验', () => {
    const cases: Array<[keyof typeof officeSamples, string, number, string]> = [
      [
        'doc',
        'application/msword',
        9728,
        '39adc5b11fa0293b819e3ddf2d1b03df387d850a3bcf2f75b904841fa812d665',
      ],
      [
        'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        5424,
        'ce0f076cc1743847ea67650ed3759ee2297ca63dc89fa59d54fd18e689a8bc2f',
      ],
      [
        'xls',
        'application/vnd.ms-excel',
        5632,
        'e8d2f1986f84f0158819948d47451b037bb93e8e10d6e765b382e4e303c9ee36',
      ],
      [
        'xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        5667,
        '7d5396cfeab71edb0b0641265211b8a78ed82bd797fc4eac85c3e07d3bddf3ce',
      ],
      [
        'ppt',
        'application/vnd.ms-powerpoint',
        458752,
        'f10a2a46ff904ffcf07fcc60611738e47ed23c3140de5cfed2f38b29eb800b1b',
      ],
      [
        'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        8101,
        '2c04aa1421afa1f88ea8c125ded904f6cac39a7782fa6dfa58f303b3fd4465bc',
      ],
    ];

    for (const [extension, mimeType, byteSize, sha256] of cases) {
      expect(resolve(officeSamples[extension], `sample.${extension}`)).toBe(mimeType);
      expect(officeSamples[extension].byteLength).toBe(byteSize);
      expect(createHash('sha256').update(officeSamples[extension]).digest('hex')).toBe(sha256);
    }
  });

  it('PDF/PNG/JPEG 的真实结构与合成图片通过校验', () => {
    expect(resolve(makeMinimalPdf(), 'sample.pdf')).toBe('application/pdf');
    expect(resolve(minimalPng, 'sample.png')).toBe('image/png');
    expect(resolve(minimalJpeg, 'sample.jpg')).toBe('image/jpeg');
    expect(resolve(minimalJpeg, 'sample.jpeg')).toBe('image/jpeg');
  });

  it('JPEG 只把 SOF 标记识别为帧：SOF1 仍通过，非 SOF 标记不当作帧', () => {
    expect(resolve(patchJpegMarker(minimalJpeg, 0xc0, 0xc1), 'sof1.jpg')).toBe('image/jpeg');
    expect(resolve(patchJpegMarker(minimalJpeg, 0xc0, 0xc4), 'non-sof.jpg')).toBeNull();
  });

  it('普通 ZIP 冒充 Office 被拒绝', () => {
    const plainZip = buildZip([{ name: 'hello.txt', data: Buffer.from('hello') }]);
    expect(resolve(plainZip, 'fake.docx')).toBeNull();
    expect(resolve(plainZip, 'fake.xlsx')).toBeNull();
    expect(resolve(plainZip, 'fake.pptx')).toBeNull();
  });

  it('Office 子类型交叉改名被拒绝（主部件与文档类型不一致）', () => {
    expect(resolve(officeSamples.docx, 'renamed.xlsx')).toBeNull();
    expect(resolve(officeSamples.xlsx, 'renamed.docx')).toBeNull();
    expect(resolve(officeSamples.pptx, 'renamed.docx')).toBeNull();
    expect(resolve(officeSamples.doc, 'renamed.xls')).toBeNull();
    expect(resolve(officeSamples.xls, 'renamed.doc')).toBeNull();
  });

  it('截断容器或仅有签名被拒绝', () => {
    expect(resolve(officeSamples.docx.subarray(0, 64), 'truncated.docx')).toBeNull();
    expect(resolve(officeSamples.doc.subarray(0, 128), 'truncated.doc')).toBeNull();
    expect(resolve(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'signature.docx')).toBeNull();
    expect(
      resolve(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'signature.doc'),
    ).toBeNull();
  });

  it('PDF/PNG/JPEG 文件头伪装或明显截断被拒绝', () => {
    expect(resolve(Buffer.from('%PDF-1.7\n', 'ascii'), 'header-only.pdf')).toBeNull();
    expect(resolve(Buffer.from('%PDF-1.7\n1 0 obj\n', 'ascii'), 'truncated.pdf')).toBeNull();
    expect(
      resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'header-only.png'),
    ).toBeNull();
    expect(resolve(minimalPng.subarray(0, minimalPng.byteLength - 12), 'truncated.png')).toBeNull();
    expect(resolve(Buffer.from([0xff, 0xd8, 0xff]), 'header-only.jpg')).toBeNull();
    expect(resolve(minimalJpeg.subarray(0, 20), 'truncated.jpg')).toBeNull();
  });

  it('超出解析预算的容器被拒绝', () => {
    const tooManyEntries = Array.from({ length: 513 }, (_, index) => ({
      name: `part-${index}.xml`,
      data: Buffer.from('<x/>', 'utf8'),
    }));
    expect(resolve(buildZip(tooManyEntries), 'too-many.docx')).toBeNull();

    const packageWithHugeDeclaredSize = ooxmlPackage('word');
    const inflatedDeclaration = (() => {
      const directoryOffset = packageWithHugeDeclaredSize.indexOf(
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      );
      const patched = Buffer.from(packageWithHugeDeclaredSize);
      patched.writeUInt32LE(100_000_000, directoryOffset + 24);
      return patched;
    })();
    expect(resolve(inflatedDeclaration, 'budget.docx')).toBeNull();
  });

  it('合法 OOXML 结构（包声明 + 关系 + 主部件）通过', () => {
    expect(resolve(ooxmlPackage('word'), 'synthetic.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolve(ooxmlPackage('sheet'), 'synthetic.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(resolve(ooxmlPackage('presentation'), 'synthetic.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('合法命名空间前缀的 OOXML 通过（旧实现按 <Default> 字面量提取会误拒）', () => {
    expect(resolve(prefixedOoxmlPackage('word'), 'prefixed.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resolve(prefixedOoxmlPackage('sheet'), 'prefixed.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(resolve(prefixedOoxmlPackage('presentation'), 'prefixed.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('错误命名空间即使 URI 仅出现在注释中也拒绝', () => {
    const wrongContentTypes = ooxmlPackage('word', {
      contentTypes: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="urn:wrong-content-types">
<!-- http://schemas.openxmlformats.org/package/2006/content-types -->
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    });
    expect(resolve(wrongContentTypes, 'wrong-content-types.docx')).toBeNull();

    const wrongRels = ooxmlPackage('word', {
      rels: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="urn:wrong-relationships">
<!-- http://schemas.openxmlformats.org/package/2006/relationships -->
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    });
    expect(resolve(wrongRels, 'wrong-rels.docx')).toBeNull();
  });

  it('DOCTYPE、根元素之后的解析错误与外部目标被拒绝', () => {
    const doctype = ooxmlPackage('word', {
      contentTypes: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE Types>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    });
    expect(resolve(doctype, 'doctype.docx')).toBeNull();

    const malformedTail = ooxmlPackage('word', {
      contentTypes: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types><Broken>`,
    });
    expect(resolve(malformedTail, 'malformed.docx')).toBeNull();

    const external = ooxmlPackage('word', {
      rels: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml" TargetMode="External"/>
</Relationships>`,
    });
    expect(resolve(external, 'external.docx')).toBeNull();
  });

  it('XML 元素数、深度与属性数预算生效', () => {
    const tooManyElements = ooxmlPackage('word', {
      contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${'<Default Extension="xml" ContentType="application/xml"/>'.repeat(10001)}</Types>`,
    });
    expect(resolve(tooManyElements, 'too-many-elements.docx')).toBeNull();

    const tooDeep = ooxmlPackage('word', {
      contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${'<a>'.repeat(64)}${'</a>'.repeat(64)}<Default Extension="xml" ContentType="application/xml"/></Types>`,
    });
    expect(resolve(tooDeep, 'too-deep.docx')).toBeNull();

    const attributes = Array.from({ length: 65 }, (_, index) => `a${index}="x"`).join(' ');
    const tooManyAttributes = ooxmlPackage('word', {
      contentTypes: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ${attributes} Extension="xml" ContentType="application/xml"/></Types>`,
    });
    expect(resolve(tooManyAttributes, 'too-many-attributes.docx')).toBeNull();
  });

  it('关键部件 CRC 不符被拒绝', () => {
    const zip = patchZipEntryCrc(ooxmlPackage('word'), '[Content_Types].xml', 0);
    expect(resolve(zip, 'bad-crc.docx')).toBeNull();
  });

  it('本地头压缩方法与中央目录不符被拒绝', () => {
    const zip = Buffer.from(ooxmlPackage('word'));
    zip.writeUInt16LE(8, 8);
    expect(resolve(zip, 'local-method.docx')).toBeNull();
  });

  it('合法数据描述符写法保留为正例', () => {
    expect(resolve(buildDescriptorPackage(), 'descriptor.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('无签名的合法数据描述符写法通过', () => {
    expect(
      resolve(
        buildDescriptorPackage({ dataDescriptorSignature: false }),
        'unsigned-descriptor.docx',
      ),
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('无签名数据描述符的 CRC 恰等于签名值 0x08074b50 时通过', () => {
    const fixture = buildUnsignedDescriptorCollidingWithSignature();
    // 无签名描述符记录恰为 12 字节：首字段是真实 CRC，不是签名前缀
    expect(fixture.centralDirectoryOffset - fixture.descriptorOffset).toBe(12);
    expect(fixture.buffer.readUInt32LE(fixture.descriptorOffset)).toBe(0x08074b50);
    expect(fixture.buffer.readUInt32LE(fixture.descriptorOffset + 4)).toBe(fixture.compressedSize);
    expect(fixture.buffer.readUInt32LE(fixture.descriptorOffset + 8)).toBe(
      fixture.uncompressedSize,
    );
    // 真实 CRC、中央目录与压缩数据三者一致
    expect(crc32(fixture.data) >>> 0).toBe(0x08074b50);
    expect(fixture.centralCrc).toBe(0x08074b50);
    expect(fixture.compressedSize).toBe(fixture.data.byteLength);
    expect(fixture.uncompressedSize).toBe(fixture.data.byteLength);
    expect(
      fixture.buffer.subarray(fixture.dataOffset, fixture.dataOffset + fixture.compressedSize),
    ).toEqual(fixture.data);

    expect(resolve(fixture.buffer, 'crc-signature-collision.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('数据描述符缺失、截断或字段与中央目录不符被拒绝', () => {
    expect(
      resolve(buildDescriptorPackage({ emitDataDescriptor: false }), 'missing-descriptor.docx'),
    ).toBeNull();
    expect(
      resolve(
        buildDescriptorPackage({ descriptorTruncateBytes: 4 }, 'last'),
        'truncated-descriptor.docx',
      ),
    ).toBeNull();
    expect(
      resolve(buildDescriptorPackage({ descriptorCrcOverride: 0 }), 'crc-descriptor.docx'),
    ).toBeNull();
    expect(
      resolve(
        buildDescriptorPackage({ descriptorCompressedSizeOverride: 0 }),
        'compressed-size-descriptor.docx',
      ),
    ).toBeNull();
    expect(
      resolve(
        buildDescriptorPackage({ descriptorUncompressedSizeOverride: 0 }),
        'uncompressed-size-descriptor.docx',
      ),
    ).toBeNull();
  });

  it('条目数据范围重叠被拒绝', () => {
    expect(resolve(buildOverlappingZip(), 'overlap.docx')).toBeNull();
  });

  it('越界条目与超出实际解压预算被拒绝（旧实现已拒绝的对照项）', () => {
    const outOfBounds = Buffer.from(ooxmlPackage('word'));
    outOfBounds.writeUInt32LE(outOfBounds.byteLength - 20, outOfBounds.byteLength - 6);
    expect(resolve(outOfBounds, 'out-of-bounds.docx')).toBeNull();

    const bomb = buildZip([
      {
        name: '[Content_Types].xml',
        data: Buffer.alloc(3 * 1024 * 1024, 0x61),
        declaredUncompressedSize: 1024 * 1024,
        compressionMethod: 8,
      },
    ]);
    expect(resolve(bomb, 'actual-budget.docx')).toBeNull();
  });

  it('OLE 重复 miniFAT 扇区被拒绝；错误链尾被拒绝', () => {
    const loopedDoc = patchCfbChainToSelf(officeSamples.doc, 'WordDocument');
    expect(resolve(loopedDoc, 'loop.doc')).toBeNull();

    const loopedPpt = patchCfbChainToSelf(officeSamples.ppt, 'PowerPoint Document');
    expect(resolve(loopedPpt, 'loop.ppt')).toBeNull();

    const brokenTail = Buffer.from(officeSamples.ppt);
    const sectorSize = 1 << brokenTail.readUInt16LE(30);
    const fatSectorId = brokenTail.readUInt32LE(76);
    brokenTail.writeUInt32LE(0xfffffffd, (fatSectorId + 1) * sectorSize + 4 * 4);
    expect(resolve(brokenTail, 'bad-tail.ppt')).toBeNull();
  });

  it('FAT 定长链取够所需扇区后仍校验后继：多余扇区或 FREE 终止均拒绝', () => {
    const parts = readCfbFixtureParts(officeSamples.ppt);
    const entry = findCfbStreamEntry(parts, 'PowerPoint Document');
    const chain = readCfbSectorChain(parts.fat, entry.startSector);
    expect(chain).toHaveLength(Math.ceil(entry.size / parts.sectorSize));

    const last = chain[chain.length - 1];
    const unusedSector = parts.fat.findIndex((next) => next === 0xffffffff);
    expect(unusedSector).toBeGreaterThanOrEqual(0);

    expect(
      resolve(
        patchCfbFatSuccessor(officeSamples.ppt, parts, last, unusedSector),
        'extra-fat-tail.ppt',
      ),
    ).toBeNull();
    expect(
      resolve(
        patchCfbFatSuccessor(officeSamples.ppt, parts, last, 0xffffffff),
        'free-fat-tail.ppt',
      ),
    ).toBeNull();
  });

  it('miniFAT 定长链取够所需扇区后仍校验后继：多余扇区或 FREE 终止均拒绝', () => {
    const parts = readCfbFixtureParts(officeSamples.doc);
    const entry = findCfbStreamEntry(parts, 'WordDocument');
    const miniFat = readCfbMiniFat(officeSamples.doc, parts);
    const chain = readCfbSectorChain(miniFat, entry.startSector);
    expect(chain).toHaveLength(Math.ceil(entry.size / 64));

    const last = chain[chain.length - 1];
    const unusedSector = miniFat.findIndex((next) => next === 0xffffffff);
    expect(unusedSector).toBeGreaterThanOrEqual(0);

    expect(
      resolve(
        patchCfbMiniFatSuccessor(officeSamples.doc, parts, last, unusedSector),
        'extra-mini-tail.doc',
      ),
    ).toBeNull();
    expect(
      resolve(
        patchCfbMiniFatSuccessor(officeSamples.doc, parts, last, 0xffffffff),
        'free-mini-tail.doc',
      ),
    ).toBeNull();
  });

  it('DIFAT 重复、超声明收集与自环链被受控拒绝（旧实现已拒绝的对照项）', () => {
    const duplicated = Buffer.from(officeSamples.xls);
    duplicated.writeUInt32LE(duplicated.readUInt32LE(76), 80);
    expect(resolve(duplicated, 'duplicate-difat.xls')).toBeNull();

    const overDeclared = Buffer.from(officeSamples.xls);
    overDeclared.writeUInt32LE(1, 80);
    expect(resolve(overDeclared, 'over-declared-difat.xls')).toBeNull();

    const looping = Buffer.from(officeSamples.xls);
    const sectorSize = 1 << looping.readUInt16LE(30);
    looping.writeUInt32LE(1, 68);
    looping.writeUInt32LE(1, 72);
    const difatOffset = 2 * sectorSize;
    looping.fill(0xff, difatOffset, difatOffset + 508);
    looping.writeUInt32LE(1, difatOffset + 508);
    expect(resolve(looping, 'looping-difat.xls')).toBeNull();
  });

  it('DIFAT 实际扇区数少于声明数被拒绝', () => {
    const shortDifat = Buffer.from(officeSamples.xls);
    const sectorSize = 1 << shortDifat.readUInt16LE(30);
    shortDifat.writeUInt32LE(1, 68);
    shortDifat.writeUInt32LE(2, 72);
    const difatOffset = 2 * sectorSize;
    shortDifat.fill(0xff, difatOffset, difatOffset + 508);
    shortDifat.writeUInt32LE(0xfffffffe, difatOffset + 508);
    expect(resolve(shortDifat, 'short-difat.xls')).toBeNull();
  });

  it('目录链尾：合法 ENDOFCHAIN 通过，FREE 后继被拒绝', () => {
    const legal = buildCfbDirectoryChainTailFixture(officeSamples.doc, 0xfffffffe);
    expect(legal.chainSectors.length).toBeGreaterThan(0);
    expect(resolve(legal.buffer, 'directory-end.doc')).toBe('application/msword');

    const illegal = buildCfbDirectoryChainTailFixture(officeSamples.doc, 0xffffffff);
    expectOnlyChainTerminatorChanged(legal, illegal);
    expect(resolve(illegal.buffer, 'directory-free.doc')).toBeNull();
  });

  it('DIFAT 链尾：实际遍历一个 DIFAT 扇区的正例通过，FREE 后继被拒绝', () => {
    const legal = buildCfbDifatChainTailFixture(officeSamples.xls, 0xfffffffe);
    expect(legal.chainSectors).toHaveLength(1);
    expect(legal.relocatedFatSectorIds).toHaveLength(1);

    const sectorSize = 1 << legal.buffer.readUInt16LE(30);
    const difatSectorId = legal.chainSectors[0];
    // FAT 扇区 ID 已从头部 DIFAT 移入 DIFAT 扇区：不遍历 DIFAT 就收集不到完整 FAT
    expect(legal.buffer.readUInt32LE(68)).toBe(difatSectorId);
    expect(legal.buffer.readUInt32LE(72)).toBe(1);
    expect(legal.buffer.readUInt32LE((difatSectorId + 1) * sectorSize)).toBe(
      legal.relocatedFatSectorIds[0],
    );
    const headerFatSectorIds: number[] = [];
    for (let slot = 0; slot < 109; slot += 1) {
      headerFatSectorIds.push(legal.buffer.readUInt32LE(76 + slot * 4));
    }
    expect(headerFatSectorIds).not.toContain(legal.relocatedFatSectorIds[0]);
    expect(resolve(legal.buffer, 'difat-end.xls')).toBe('application/vnd.ms-excel');

    const illegal = buildCfbDifatChainTailFixture(officeSamples.xls, 0xffffffff);
    expectOnlyChainTerminatorChanged(legal, illegal);
    expect(resolve(illegal.buffer, 'difat-free.xls')).toBeNull();

    // 合法的零 DIFAT 扇区场景保留
    expect(officeSamples.xls.readUInt32LE(72)).toBe(0);
    expect(resolve(officeSamples.xls, 'zero-difat.xls')).toBe('application/vnd.ms-excel');
  });

  it('UTF-8 文本通过；带 NUL 或非法 UTF-8 的二进制冒充文本被拒绝', () => {
    expect(resolve(Buffer.from('维修过程：更换光源\n', 'utf8'), '记录.txt')).toBe('text/plain');
    expect(resolve(Buffer.from('# 维修记录\n', 'utf8'), '记录.md')).toBe('text/markdown');
    expect(resolve(Buffer.from('序号,结果\n1,正常\n', 'utf8'), '记录.csv')).toBe('text/csv');
    expect(resolve(Buffer.from([0x61, 0x00, 0x62]), 'record.txt')).toBeNull();
    expect(resolve(Buffer.from([0xff, 0xfe, 0xfd]), 'record.csv')).toBeNull();
  });

  it('实际内容与扩展名不符被拒绝', () => {
    expect(resolve(Buffer.from('not-a-pdf'), 'fake.pdf')).toBeNull();
    expect(resolve(minimalPng, 'fake.txt')).toBeNull();
  });

  it('扩展名未知或 MIME 不在服务端白名单时被拒绝', () => {
    expect(resolve(makeMinimalPdf(), 'a.exe')).toBeNull();
    expect(
      resolveVerifiedStoredFileMimeType({
        buffer: makeMinimalPdf(),
        originalFilename: 'a.pdf',
        allowedMimeTypes: [],
      }),
    ).toBeNull();
  });

  it('空内容返回 null', () => {
    expect(resolve(Buffer.alloc(0), 'a.pdf')).toBeNull();
  });

  it('样本 SHA-256 稳定（可追溯合成夹具，不含真实用户原件）', () => {
    const digest = createHash('sha256').update(officeSamples.docx).digest('hex');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update(officeSamples.docx).digest('hex'));
  });
});
