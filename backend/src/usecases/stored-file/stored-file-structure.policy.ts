// src/usecases/stored-file/stored-file-structure.policy.ts

import { crc32, inflateRawSync } from 'node:zlib';

import * as path from 'node:path';

import { SaxesParser, type SaxesTagNS } from 'saxes';

/**
 * 上传前文件结构校验（纯内存、无 I/O、无渲染/执行）。
 *
 * 只做「容器结构 + 文档主部件 + 文档类型」的必要核验，不把扩展名、ZIP 签名、
 * OLE 共享签名或单个条目名当作充分条件；所有解析均受条目数、解压体积与链长预算约束。
 */

export type OoxmlKind = 'word' | 'sheet' | 'presentation';
export type OleKind = 'doc' | 'xls' | 'ppt';

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const CONTENT_TYPES_PART = '[Content_Types].xml';
const PACKAGE_RELS_PART = '_rels/.rels';

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_RELS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';

const OOXML_MAIN_CONTENT_TYPES: Record<OoxmlKind, string> = {
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};

const OOXML_MAIN_ROOT_NAMES: Record<OoxmlKind, string> = {
  word: 'document',
  sheet: 'workbook',
  presentation: 'presentation',
};

const OOXML_LIMITS = {
  maxEntries: 512,
  maxContentTypesBytes: 2 * 1024 * 1024,
  maxRelsBytes: 512 * 1024,
  maxMainPartBytes: 8 * 1024 * 1024,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxActualInflatedBytes: 16 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlElements: 10000,
  maxXmlAttributesPerElement: 64,
} as const;

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_FREE_SECTOR = 0xffffffff;
const CFB_MINI_SECTOR_SIZE = 64;
const CFB_LIMITS = {
  maxSectorShift: 12,
  maxFatSectors: 8192,
  maxDirectoryEntries: 4096,
  maxChainSteps: 1000000,
  maxDirectoryBytes: 1024 * 1024,
  maxStreamBytes: 20 * 1024 * 1024,
} as const;

class InvalidStructureError extends Error {}

function assertStructure(condition: unknown, reason: string): asserts condition {
  if (!condition) {
    throw new InvalidStructureError(reason);
  }
}

function isValidWith(validate: () => void): boolean {
  try {
    validate();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------- OOXML / ZIP ------------------------------- */

type ZipEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
  dataEnd: number;
};

type ZipReadBudget = { inflatedBytes: number };

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.byteLength - 22 - 0xffff);
  for (let offset = buffer.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.byteLength) {
      return offset;
    }
  }
  return -1;
}

function assertSafeZipEntryName(name: string): void {
  assertStructure(name.length > 0 && name.length <= 255, 'zip entry name length');
  assertStructure(!name.includes('\\'), 'zip entry separator');
  assertStructure(!name.startsWith('/'), 'zip entry absolute path');
  assertStructure(
    [...name].every((character) => character.charCodeAt(0) > 0x1f),
    'zip entry control character',
  );
  for (const segment of name.split('/')) {
    assertStructure(segment !== '..' && segment !== '.', 'zip entry traversal');
  }
}

function readZipDirectory(buffer: Buffer): Map<string, ZipEntry> {
  assertStructure(buffer.byteLength >= 22, 'zip too short');
  const eocdOffset = findEndOfCentralDirectory(buffer);
  assertStructure(eocdOffset >= 0, 'zip end of central directory');

  assertStructure(buffer.readUInt16LE(eocdOffset + 4) === 0, 'zip multi-disk');
  assertStructure(buffer.readUInt16LE(eocdOffset + 6) === 0, 'zip central directory disk');

  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  assertStructure(entriesOnDisk === totalEntries, 'zip entry count mismatch');
  assertStructure(totalEntries > 0 && totalEntries <= OOXML_LIMITS.maxEntries, 'zip entry count');
  assertStructure(
    centralDirectorySize !== 0xffffffff && centralDirectoryOffset !== 0xffffffff,
    'zip64 unsupported',
  );
  assertStructure(
    centralDirectoryOffset + centralDirectorySize <= eocdOffset,
    'zip central directory bounds',
  );

  const entries = new Map<string, ZipEntry>();
  const ranges: Array<{ start: number; end: number }> = [];
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let totalUncompressedBytes = 0;
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    assertStructure(cursor + 46 <= centralDirectoryEnd, 'zip central directory truncated');
    assertStructure(
      buffer.readUInt32LE(cursor) === ZIP_CENTRAL_SIGNATURE,
      'zip central directory signature',
    );

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;

    assertStructure(recordEnd <= centralDirectoryEnd, 'zip central directory entry bounds');
    assertStructure((flags & 0x1) === 0, 'zip encrypted entry');
    assertStructure(compressionMethod === 0 || compressionMethod === 8, 'zip compression method');
    assertStructure(
      compressedSize !== 0xffffffff &&
        uncompressedSize !== 0xffffffff &&
        localHeaderOffset !== 0xffffffff,
      'zip64 entry unsupported',
    );

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assertSafeZipEntryName(name);

    const local = readZipLocalRecord(buffer, centralDirectoryOffset, {
      name,
      flags,
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    ranges.push({ start: localHeaderOffset, end: local.recordEnd });

    if (name.endsWith('/')) {
      // 目录条目不承载文档内容
      assertStructure(uncompressedSize === 0 && compressedSize === 0, 'zip directory entry size');
      cursor = recordEnd;
      continue;
    }
    assertStructure(!entries.has(name), 'zip duplicate entry');

    totalUncompressedBytes += uncompressedSize;
    assertStructure(
      totalUncompressedBytes <= OOXML_LIMITS.maxTotalUncompressedBytes,
      'zip uncompressed budget',
    );

    entries.set(name, {
      name,
      flags,
      compressionMethod,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      dataOffset: local.dataOffset,
      dataEnd: local.dataEnd,
    });
    cursor = recordEnd;
  }

  assertStructure(cursor <= centralDirectoryEnd, 'zip central directory overrun');

  // 本地头与数据区不得与其他条目的本地头/数据区重叠，也不得侵入中央目录。
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    assertStructure(ranges[index - 1].end <= ranges[index].start, 'zip entry overlap');
  }

  return entries;
}

function readZipLocalRecord(
  buffer: Buffer,
  centralDirectoryOffset: number,
  entry: {
    name: string;
    flags: number;
    compressionMethod: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  },
): { dataOffset: number; dataEnd: number; recordEnd: number } {
  const { localHeaderOffset } = entry;
  assertStructure(localHeaderOffset + 30 <= centralDirectoryOffset, 'zip local header bounds');
  assertStructure(
    buffer.readUInt32LE(localHeaderOffset) === ZIP_LOCAL_SIGNATURE,
    'zip local header signature',
  );
  const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
  const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
  const localCrc = buffer.readUInt32LE(localHeaderOffset + 14);
  const localCompressedSize = buffer.readUInt32LE(localHeaderOffset + 18);
  const localUncompressedSize = buffer.readUInt32LE(localHeaderOffset + 22);
  const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);

  assertStructure((localFlags & 0x1) === 0, 'zip local encrypted entry');
  assertStructure(
    (localFlags & 0x8) === (entry.flags & 0x8),
    'zip local data descriptor flag mismatch',
  );
  assertStructure(
    localCompressionMethod === entry.compressionMethod,
    'zip local compression method mismatch',
  );

  const hasDataDescriptor = (entry.flags & 0x8) !== 0;
  if (hasDataDescriptor) {
    assertStructure(
      (localCrc === 0 || localCrc === entry.crc32) &&
        (localCompressedSize === 0 || localCompressedSize === entry.compressedSize) &&
        (localUncompressedSize === 0 || localUncompressedSize === entry.uncompressedSize),
      'zip local descriptor fields',
    );
  } else {
    assertStructure(localCrc === entry.crc32, 'zip local crc mismatch');
    assertStructure(
      localCompressedSize === entry.compressedSize,
      'zip local compressed size mismatch',
    );
    assertStructure(
      localUncompressedSize === entry.uncompressedSize,
      'zip local uncompressed size mismatch',
    );
  }

  const localName = buffer.toString(
    'utf8',
    localHeaderOffset + 30,
    localHeaderOffset + 30 + localNameLength,
  );
  assertStructure(localName === entry.name, 'zip local header name mismatch');

  const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  assertStructure(dataEnd <= centralDirectoryOffset, 'zip entry data overlaps central directory');
  const recordEnd = hasDataDescriptor
    ? readZipDataDescriptor(buffer, dataEnd, centralDirectoryOffset, entry)
    : dataEnd;
  return { dataOffset, dataEnd, recordEnd };
}

function readZipDataDescriptor(
  buffer: Buffer,
  offset: number,
  limit: number,
  entry: { crc32: number; compressedSize: number; uncompressedSize: number },
): number {
  const fieldsMatch = (fieldsOffset: number): boolean =>
    fieldsOffset + 12 <= limit &&
    buffer.readUInt32LE(fieldsOffset) === entry.crc32 &&
    buffer.readUInt32LE(fieldsOffset + 4) === entry.compressedSize &&
    buffer.readUInt32LE(fieldsOffset + 8) === entry.uncompressedSize;

  // 有无签名的两种布局字段边界不同，且都必须落在记录区间内。
  // 不以首字段是否等于签名值直接选分支：无签名描述符的真实 CRC
  // 也可能恰好等于签名值；只有完整 CRC/压缩大小/解压大小全部吻合才接受。
  const signedMatches =
    offset + 16 <= limit &&
    buffer.readUInt32LE(offset) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    fieldsMatch(offset + 4);
  const unsignedMatches = offset + 12 <= limit && fieldsMatch(offset);

  if (signedMatches && !unsignedMatches) {
    return offset + 16;
  }
  if (unsignedMatches && !signedMatches) {
    return offset + 12;
  }
  throw new InvalidStructureError('zip data descriptor');
}

function readZipEntry(
  buffer: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
  maxBytes: number,
  budget: ZipReadBudget,
): Buffer {
  const entry = entries.get(name);
  assertStructure(entry !== undefined, `zip missing entry ${name}`);
  assertStructure(entry.uncompressedSize <= maxBytes, `zip entry budget ${name}`);
  assertStructure(entry.compressedSize <= buffer.byteLength, `zip entry compressed bounds ${name}`);

  const compressed = buffer.subarray(entry.dataOffset, entry.dataEnd);
  let output: Buffer;
  if (entry.compressionMethod === 0) {
    assertStructure(entry.compressedSize === entry.uncompressedSize, 'zip stored entry size');
    output = compressed;
  } else {
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch {
      throw new InvalidStructureError('zip entry inflate failed');
    }
    assertStructure(inflated.byteLength === entry.uncompressedSize, 'zip entry inflated size');
    output = inflated;
  }

  budget.inflatedBytes += output.byteLength;
  assertStructure(
    budget.inflatedBytes <= OOXML_LIMITS.maxActualInflatedBytes,
    'zip actual inflate budget',
  );
  assertStructure(crc32(output) >>> 0 === entry.crc32, `zip entry crc ${name}`);
  return output;
}

function decodeXmlPart(buffer: Buffer, partName: string): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new InvalidStructureError(`xml utf-8 ${partName}`);
  }
  assertStructure(!text.includes('\u0000'), `xml nul ${partName}`);
  return text;
}

class XmlRootFound extends Error {}

type XmlBudget = { depth: number; elements: number };

function createNamespacedXmlParser(): SaxesParser<{ xmlns: true }> {
  const parser = new SaxesParser<{ xmlns: true }>({ xmlns: true });
  parser.on('doctype', (): never => {
    throw new InvalidStructureError('xml doctype');
  });
  parser.on('error', (): never => {
    throw new InvalidStructureError('xml parse error');
  });
  return parser;
}

function accountXmlElement(budget: XmlBudget, tag: SaxesTagNS): void {
  budget.depth += 1;
  budget.elements += 1;
  assertStructure(budget.depth <= OOXML_LIMITS.maxXmlDepth, 'xml depth budget');
  assertStructure(budget.elements <= OOXML_LIMITS.maxXmlElements, 'xml element budget');
  assertStructure(
    Object.keys(tag.attributes).length <= OOXML_LIMITS.maxXmlAttributesPerElement,
    'xml attribute budget',
  );
}

function readUnqualifiedAttribute(tag: SaxesTagNS, localName: string): string | null {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.uri === '' && attribute.local === localName) {
      return attribute.value;
    }
  }
  return null;
}

function assertXmlRootIdentity(
  tag: SaxesTagNS,
  expectedNamespace: string,
  expectedLocal: string,
): void {
  assertStructure(
    tag.uri === expectedNamespace && tag.local === expectedLocal,
    `xml root ${expectedLocal}`,
  );
}

/**
 * 主部件只识别根元素以判定文档子类型，不校验其完整 XML。
 * 用异常在首个根元素处停止解析，避免为 8 MiB 主部件构建完整树。
 */
function assertMainPartRoot(text: string, expectedLocalName: string): void {
  const parser = createNamespacedXmlParser();
  let rootSeen = false;
  parser.on('opentag', (tag: SaxesTagNS): never => {
    assertXmlRootIdentity(tag, expectedMainNamespace(expectedLocalName), expectedLocalName);
    rootSeen = true;
    throw new XmlRootFound();
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (!(error instanceof XmlRootFound)) {
      throw error;
    }
  }
  assertStructure(rootSeen, `xml root ${expectedLocalName}`);
}

function expectedMainNamespace(expectedLocalName: string): string {
  return expectedLocalName === 'document'
    ? 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    : expectedLocalName === 'workbook'
      ? 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
      : 'http://schemas.openxmlformats.org/presentationml/2006/main';
}

function parseContentTypes(text: string): {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
} {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const budget: XmlBudget = { depth: 0, elements: 0 };
  const parser = createNamespacedXmlParser();

  parser.on('opentag', (tag: SaxesTagNS): void => {
    accountXmlElement(budget, tag);
    if (budget.depth === 1) {
      assertXmlRootIdentity(tag, CONTENT_TYPES_NAMESPACE, 'Types');
      return;
    }
    if (budget.depth !== 2 || tag.uri !== CONTENT_TYPES_NAMESPACE) {
      return;
    }
    if (tag.local === 'Default') {
      const extension = readUnqualifiedAttribute(tag, 'Extension');
      const contentType = readUnqualifiedAttribute(tag, 'ContentType');
      assertStructure(extension && contentType, 'content types default attributes');
      defaults.set(extension.toLowerCase(), contentType);
    } else if (tag.local === 'Override') {
      const partName = readUnqualifiedAttribute(tag, 'PartName');
      const contentType = readUnqualifiedAttribute(tag, 'ContentType');
      assertStructure(partName && contentType, 'content types override attributes');
      assertStructure(partName.startsWith('/'), 'content types override part name');
      overrides.set(normalizeOoxmlPartName(partName), contentType);
    }
  });
  parser.on('closetag', (): void => {
    budget.depth -= 1;
  });

  parser.write(text).close();
  assertStructure(defaults.size + overrides.size > 0, 'content types entries');
  return { defaults, overrides };
}

function normalizeOoxmlPartName(partName: string): string {
  const withoutLeadingSlash = partName.replace(/^\/+/, '');
  const segments = withoutLeadingSlash.split('/');
  assertStructure(segments.length > 0, 'ooxml part name');
  for (const segment of segments) {
    assertStructure(
      segment.length > 0 && segment !== '.' && segment !== '..',
      'ooxml part segment',
    );
  }
  return segments.join('/');
}

function findOfficeDocumentTarget(relsText: string): string {
  const budget: XmlBudget = { depth: 0, elements: 0 };
  const parser = createNamespacedXmlParser();
  let relationshipCount = 0;
  let target: string | null = null;

  parser.on('opentag', (tag: SaxesTagNS): void => {
    accountXmlElement(budget, tag);
    if (budget.depth === 1) {
      assertXmlRootIdentity(tag, PACKAGE_RELS_NAMESPACE, 'Relationships');
      return;
    }
    if (budget.depth !== 2 || tag.uri !== PACKAGE_RELS_NAMESPACE || tag.local !== 'Relationship') {
      return;
    }
    relationshipCount += 1;
    const type = readUnqualifiedAttribute(tag, 'Type');
    if (!type || !type.endsWith('/officeDocument')) {
      return;
    }
    assertStructure(
      readUnqualifiedAttribute(tag, 'TargetMode') !== 'External',
      'office document external',
    );
    const relationshipTarget = readUnqualifiedAttribute(tag, 'Target');
    assertStructure(relationshipTarget !== null, 'office document target');
    assertStructure(
      !/^[a-z][a-z0-9+.-]*:/i.test(relationshipTarget) && !relationshipTarget.startsWith('//'),
      'office document external target',
    );
    target = normalizeOoxmlPartName(relationshipTarget);
  });
  parser.on('closetag', (): void => {
    budget.depth -= 1;
  });

  parser.write(relsText).close();
  assertStructure(relationshipCount > 0, 'package rels entries');
  assertStructure(target !== null, 'office document relationship');
  return target;
}

function resolveOoxmlPartContentType(
  entryName: string,
  defaults: Map<string, string>,
  overrides: Map<string, string>,
): string | null {
  const override = overrides.get(entryName);
  if (override) {
    return override;
  }
  const extension = path.extname(entryName).slice(1).toLowerCase();
  return defaults.get(extension) ?? null;
}

function validateOoxml(buffer: Buffer, kind: OoxmlKind): void {
  const entries = readZipDirectory(buffer);
  const budget: ZipReadBudget = { inflatedBytes: 0 };

  const contentTypesText = decodeXmlPart(
    readZipEntry(buffer, entries, CONTENT_TYPES_PART, OOXML_LIMITS.maxContentTypesBytes, budget),
    CONTENT_TYPES_PART,
  );
  const { defaults, overrides } = parseContentTypes(contentTypesText);

  const packageRelsText = decodeXmlPart(
    readZipEntry(buffer, entries, PACKAGE_RELS_PART, OOXML_LIMITS.maxRelsBytes, budget),
    PACKAGE_RELS_PART,
  );
  const mainPartName = findOfficeDocumentTarget(packageRelsText);
  const mainPartContentType = resolveOoxmlPartContentType(mainPartName, defaults, overrides);
  assertStructure(
    mainPartContentType === OOXML_MAIN_CONTENT_TYPES[kind],
    `ooxml main content type ${kind}`,
  );

  const mainPartText = decodeXmlPart(
    readZipEntry(buffer, entries, mainPartName, OOXML_LIMITS.maxMainPartBytes, budget),
    mainPartName,
  );
  // 仅识别主部件根元素以确认子类型，不声称验证了完整主 XML 或整个文档。
  assertMainPartRoot(mainPartText, OOXML_MAIN_ROOT_NAMES[kind]);
}

export function isOoxmlStructureValid(buffer: Buffer, kind: OoxmlKind): boolean {
  return isValidWith(() => validateOoxml(buffer, kind));
}

/* ---------------------------- OLE / legacy Office --------------------------- */

type CfbDirectoryEntry = {
  name: string;
  objectType: number;
  startSector: number;
  size: number;
};

function cfbSectorOffset(sectorId: number, sectorSize: number): number {
  return (sectorId + 1) * sectorSize;
}

function readCfbFat(
  buffer: Buffer,
  sectorSize: number,
  maxSector: number,
  fatSectorIds: readonly number[],
  fatSectorCount: number,
): number[] {
  assertStructure(fatSectorIds.length === fatSectorCount, 'cfb fat sector count');
  assertStructure(new Set(fatSectorIds).size === fatSectorIds.length, 'cfb duplicate fat sector');
  const fat: number[] = [];
  for (let index = 0; index < fatSectorCount; index += 1) {
    const sectorId = fatSectorIds[index];
    assertStructure(Number.isInteger(sectorId), 'cfb fat sector id');
    const offset = cfbSectorOffset(sectorId, sectorSize);
    assertStructure(offset + sectorSize <= buffer.byteLength, 'cfb fat sector bounds');
    assertStructure(sectorId <= maxSector, 'cfb fat sector range');
    for (let cursor = offset; cursor < offset + sectorSize; cursor += 4) {
      fat.push(buffer.readUInt32LE(cursor));
    }
  }
  assertStructure(fat.length >= maxSector + 1, 'cfb fat coverage');
  return fat;
}

function collectCfbDifatSectorIds(
  buffer: Buffer,
  sectorSize: number,
  maxSector: number,
  fatSectorCount: number,
  firstDifatSector: number,
  difatSectorCount: number,
): number[] {
  const fatSectorIds: number[] = [];
  const seen = new Set<number>();
  const addFatSector = (sectorId: number): void => {
    assertStructure(fatSectorIds.length < fatSectorCount, 'cfb fat sector over-declared');
    assertStructure(sectorId <= maxSector, 'cfb fat sector range');
    assertStructure(
      cfbSectorOffset(sectorId, sectorSize) + sectorSize <= buffer.byteLength,
      'cfb fat sector bounds',
    );
    assertStructure(!seen.has(sectorId), 'cfb duplicate fat sector');
    seen.add(sectorId);
    fatSectorIds.push(sectorId);
  };

  for (let index = 0; index < 109; index += 1) {
    const sectorId = buffer.readUInt32LE(76 + index * 4);
    if (sectorId !== CFB_FREE_SECTOR) {
      addFatSector(sectorId);
    }
  }

  const entriesPerSector = sectorSize / 4;
  const visitedDifatSectors = new Set<number>();
  let difatSector = firstDifatSector;
  let steps = 0;
  while (difatSector !== CFB_END_OF_CHAIN) {
    // 已开始遍历后只有 ENDOFCHAIN 是正常结束；FREE 不是合法链尾。
    assertStructure(difatSector !== CFB_FREE_SECTOR, 'cfb difat chain terminator');
    assertStructure(difatSector <= maxSector, 'cfb difat sector range');
    assertStructure(!visitedDifatSectors.has(difatSector), 'cfb difat loop');
    assertStructure(steps < difatSectorCount, 'cfb difat chain length');
    assertStructure(steps <= maxSector, 'cfb difat actual sector budget');
    assertStructure(steps < CFB_LIMITS.maxChainSteps, 'cfb difat chain budget');
    visitedDifatSectors.add(difatSector);

    const offset = cfbSectorOffset(difatSector, sectorSize);
    assertStructure(offset + sectorSize <= buffer.byteLength, 'cfb difat sector bounds');
    for (let index = 0; index < entriesPerSector - 1; index += 1) {
      const sectorId = buffer.readUInt32LE(offset + index * 4);
      if (sectorId !== CFB_FREE_SECTOR) {
        addFatSector(sectorId);
      }
    }
    difatSector = buffer.readUInt32LE(offset + (entriesPerSector - 1) * 4);
    steps += 1;
  }

  assertStructure(steps === difatSectorCount, 'cfb difat sector count');
  assertStructure(fatSectorIds.length === fatSectorCount, 'cfb fat sector count');
  return fatSectorIds;
}

function alignedSectorBytes(bytes: number, sectorSize: number): number {
  return Math.ceil(bytes / sectorSize) * sectorSize;
}

function readCfbChain(
  buffer: Buffer,
  fat: readonly number[],
  startSector: number,
  sectorSize: number,
  maxSector: number,
  stopAfterBytes: number | null,
  maxBytes: number,
): Buffer {
  assertStructure(maxBytes >= 0 && maxBytes <= CFB_LIMITS.maxStreamBytes, 'cfb stream budget');
  assertStructure(
    stopAfterBytes === null || (stopAfterBytes >= 0 && stopAfterBytes <= maxBytes),
    'cfb stream budget',
  );
  const chunks: Buffer[] = [];
  const visited = new Set<number>();
  let sector = startSector;
  let totalBytes = 0;
  let steps = 0;

  while (sector !== CFB_END_OF_CHAIN && sector !== CFB_FREE_SECTOR) {
    if (stopAfterBytes !== null && totalBytes >= stopAfterBytes) {
      break;
    }
    assertStructure(Number.isInteger(sector) && sector >= 0, 'cfb chain sector');
    assertStructure(sector <= maxSector, 'cfb chain sector range');
    assertStructure(sector < fat.length, 'cfb chain fat bounds');
    assertStructure(!visited.has(sector), 'cfb chain loop');
    assertStructure(steps < CFB_LIMITS.maxChainSteps, 'cfb chain budget');
    assertStructure(steps <= maxSector, 'cfb chain actual sector budget');
    assertStructure(totalBytes + sectorSize <= maxBytes, 'cfb chain over budget');
    visited.add(sector);

    const offset = cfbSectorOffset(sector, sectorSize);
    assertStructure(offset + sectorSize <= buffer.byteLength, 'cfb chain sector bounds');
    chunks.push(buffer.subarray(offset, offset + sectorSize));
    totalBytes += sectorSize;
    steps += 1;
    sector = fat[sector];
  }

  if (stopAfterBytes !== null) {
    assertStructure(totalBytes >= stopAfterBytes, 'cfb chain truncated');
    // 已取到声明长度所需的最后一个扇区后，后继仍必须是合法链尾，不能因字节够用就放行。
    assertStructure(sector === CFB_END_OF_CHAIN, 'cfb chain terminator');
    return Buffer.concat(chunks).subarray(0, stopAfterBytes);
  }
  // 目录链没有声明长度：自然读完后，后继同样必须是合法链尾。
  assertStructure(sector === CFB_END_OF_CHAIN, 'cfb chain terminator');
  return Buffer.concat(chunks);
}

function readCfbMiniChain(
  miniStream: Buffer,
  miniFat: readonly number[],
  startSector: number,
  size: number,
): Buffer {
  assertStructure(size <= miniStream.byteLength, 'cfb mini stream bounds');
  const chunks: Buffer[] = [];
  const visited = new Set<number>();
  const maxMiniSectors = Math.floor(miniStream.byteLength / CFB_MINI_SECTOR_SIZE);
  let sector = startSector;
  let totalBytes = 0;
  let steps = 0;

  while (sector !== CFB_END_OF_CHAIN && sector !== CFB_FREE_SECTOR && totalBytes < size) {
    assertStructure(Number.isInteger(sector) && sector >= 0, 'cfb mini sector');
    assertStructure(sector < miniFat.length, 'cfb mini fat bounds');
    assertStructure(!visited.has(sector), 'cfb mini chain loop');
    assertStructure(steps < CFB_LIMITS.maxChainSteps, 'cfb mini chain budget');
    assertStructure(steps <= maxMiniSectors, 'cfb mini actual sector budget');
    visited.add(sector);

    const offset = sector * CFB_MINI_SECTOR_SIZE;
    assertStructure(offset + CFB_MINI_SECTOR_SIZE <= miniStream.byteLength, 'cfb mini bounds');
    chunks.push(miniStream.subarray(offset, offset + CFB_MINI_SECTOR_SIZE));
    totalBytes += CFB_MINI_SECTOR_SIZE;
    steps += 1;
    sector = miniFat[sector];
  }

  assertStructure(totalBytes >= size, 'cfb mini chain truncated');
  assertStructure(
    totalBytes <= Math.ceil(size / CFB_MINI_SECTOR_SIZE) * CFB_MINI_SECTOR_SIZE,
    'cfb mini chain over budget',
  );
  assertStructure(sector === CFB_END_OF_CHAIN, 'cfb mini chain terminator');
  return Buffer.concat(chunks).subarray(0, size);
}

function parseCfbDirectory(directoryBytes: Buffer): {
  root: CfbDirectoryEntry;
  streams: Map<string, CfbDirectoryEntry>;
} {
  const entryCount = Math.floor(directoryBytes.byteLength / 128);
  assertStructure(entryCount <= CFB_LIMITS.maxDirectoryEntries, 'cfb directory entries budget');
  const streams = new Map<string, CfbDirectoryEntry>();
  let root: CfbDirectoryEntry | null = null;

  for (let index = 0; index < entryCount; index += 1) {
    const base = index * 128;
    const nameLength = directoryBytes.readUInt16LE(base + 64);
    if (nameLength === 0) {
      continue;
    }
    assertStructure(nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0, 'cfb name length');

    const name = directoryBytes.toString('utf16le', base, base + nameLength - 2);
    const objectType = directoryBytes[base + 66];
    const startSector = directoryBytes.readUInt32LE(base + 116);
    const sizeLow = directoryBytes.readUInt32LE(base + 120);
    const sizeHigh = directoryBytes.readUInt32LE(base + 124);
    assertStructure(sizeHigh === 0, 'cfb stream size high');

    const entry: CfbDirectoryEntry = { name, objectType, startSector, size: sizeLow };
    if (objectType === 5) {
      root = entry;
    } else if (objectType === 2) {
      assertStructure(!streams.has(name.toLowerCase()), 'cfb duplicate stream');
      streams.set(name.toLowerCase(), entry);
    }
  }

  assertStructure(root !== null, 'cfb root entry');
  return { root, streams };
}

function readCfbStream(
  miniStream: Buffer | null,
  miniFat: readonly number[],
  miniStreamCutoff: number,
  buffer: Buffer,
  fat: readonly number[],
  sectorSize: number,
  maxSector: number,
  entry: CfbDirectoryEntry,
): Buffer {
  assertStructure(entry.size <= CFB_LIMITS.maxStreamBytes, 'cfb stream size budget');
  if (entry.size < miniStreamCutoff) {
    assertStructure(miniStream !== null, 'cfb mini stream missing');
    return readCfbMiniChain(miniStream, miniFat, entry.startSector, entry.size);
  }
  return readCfbChain(
    buffer,
    fat,
    entry.startSector,
    sectorSize,
    maxSector,
    entry.size,
    alignedSectorBytes(entry.size, sectorSize),
  );
}

type CfbHeader = {
  sectorSize: number;
  maxSector: number;
  fatSectorCount: number;
  firstDirectorySector: number;
  miniStreamCutoff: number;
  firstMiniFatSector: number;
  miniFatSectorCount: number;
  firstDifatSector: number;
  difatSectorCount: number;
};

function readCfbHeader(buffer: Buffer): CfbHeader {
  assertStructure(buffer.byteLength >= 512, 'cfb too short');
  assertStructure(buffer.subarray(0, 8).equals(CFB_SIGNATURE), 'cfb signature');

  const majorVersion = buffer.readUInt16LE(26);
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  assertStructure(buffer.readUInt16LE(28) === 0xfffe, 'cfb byte order');
  assertStructure(
    (majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12),
    'cfb version/sector',
  );
  assertStructure(miniSectorShift === 6, 'cfb mini sector shift');
  assertStructure(sectorShift <= CFB_LIMITS.maxSectorShift, 'cfb sector shift');

  const sectorSize = 1 << sectorShift;
  assertStructure(buffer.byteLength >= sectorSize, 'cfb sector data');
  const maxSector = Math.floor(buffer.byteLength / sectorSize) - 2;
  assertStructure(maxSector >= 0, 'cfb sector count');

  const header: CfbHeader = {
    sectorSize,
    maxSector,
    fatSectorCount: buffer.readUInt32LE(44),
    firstDirectorySector: buffer.readUInt32LE(48),
    miniStreamCutoff: buffer.readUInt32LE(56),
    firstMiniFatSector: buffer.readUInt32LE(60),
    miniFatSectorCount: buffer.readUInt32LE(64),
    firstDifatSector: buffer.readUInt32LE(68),
    difatSectorCount: buffer.readUInt32LE(72),
  };
  assertStructure(
    header.fatSectorCount > 0 && header.fatSectorCount <= CFB_LIMITS.maxFatSectors,
    'cfb fat sectors',
  );
  assertStructure(header.miniStreamCutoff > 0, 'cfb mini stream cutoff');
  assertStructure(header.miniFatSectorCount <= CFB_LIMITS.maxFatSectors, 'cfb mini fat sectors');
  // 声明数量不得超过实际扇区总数，避免后续按声明读取或追加。
  assertStructure(header.fatSectorCount <= maxSector + 1, 'cfb fat sector declaration');
  assertStructure(header.miniFatSectorCount <= maxSector + 1, 'cfb mini fat sector declaration');
  assertStructure(header.difatSectorCount <= maxSector + 1, 'cfb difat sector declaration');
  return header;
}

function validateOle(buffer: Buffer, kind: OleKind): void {
  const {
    sectorSize,
    maxSector,
    fatSectorCount,
    firstDirectorySector,
    miniStreamCutoff,
    firstMiniFatSector,
    miniFatSectorCount,
    firstDifatSector,
    difatSectorCount,
  } = readCfbHeader(buffer);

  const fatSectorIds = collectCfbDifatSectorIds(
    buffer,
    sectorSize,
    maxSector,
    fatSectorCount,
    firstDifatSector,
    difatSectorCount,
  );
  const fat = readCfbFat(buffer, sectorSize, maxSector, fatSectorIds, fatSectorCount);

  const directoryBytes = readCfbChain(
    buffer,
    fat,
    firstDirectorySector,
    sectorSize,
    maxSector,
    null,
    CFB_LIMITS.maxDirectoryBytes,
  );
  assertStructure(directoryBytes.byteLength % 128 === 0, 'cfb directory alignment');
  const { root, streams } = parseCfbDirectory(directoryBytes);

  const miniFatBytes =
    miniFatSectorCount > 0
      ? readCfbChain(
          buffer,
          fat,
          firstMiniFatSector,
          sectorSize,
          maxSector,
          miniFatSectorCount * sectorSize,
          miniFatSectorCount * sectorSize,
        )
      : Buffer.alloc(0);
  const miniFat: number[] = [];
  for (let cursor = 0; cursor + 4 <= miniFatBytes.byteLength; cursor += 4) {
    miniFat.push(miniFatBytes.readUInt32LE(cursor));
  }

  const miniStream =
    root.size > 0
      ? readCfbChain(
          buffer,
          fat,
          root.startSector,
          sectorSize,
          maxSector,
          root.size,
          alignedSectorBytes(root.size, sectorSize),
        )
      : null;

  const findStream = (...names: readonly string[]): CfbDirectoryEntry | null => {
    for (const name of names) {
      const entry = streams.get(name);
      if (entry) {
        return entry;
      }
    }
    return null;
  };

  const entry =
    kind === 'doc'
      ? findStream('worddocument')
      : kind === 'xls'
        ? findStream('workbook', 'book')
        : findStream('powerpoint document');
  assertStructure(entry !== null, `cfb ${kind} stream`);
  assertStructure(entry.size > 0, `cfb ${kind} stream size`);

  const stream = readCfbStream(
    miniStream,
    miniFat,
    miniStreamCutoff,
    buffer,
    fat,
    sectorSize,
    maxSector,
    entry,
  );

  if (kind === 'doc') {
    assertStructure(stream.byteLength >= 32 && stream.readUInt16LE(0) === 0xa5ec, 'doc fib');
  } else if (kind === 'xls') {
    assertStructure(stream.byteLength >= 4 && stream.readUInt16LE(0) === 0x0809, 'xls bof');
  } else {
    assertStructure(
      stream.byteLength >= 8 && (stream[0] & 0x0f) === 0x0f && stream.readUInt16LE(2) === 0x03e8,
      'ppt document record',
    );
  }
}

export function isOleStructureValid(buffer: Buffer, kind: OleKind): boolean {
  return isValidWith(() => validateOle(buffer, kind));
}

/* --------------------------------- PDF ----------------------------------- */

export function isPdfStructureValid(buffer: Buffer): boolean {
  return isValidWith(() => validatePdf(buffer));
}

function validatePdf(buffer: Buffer): void {
  assertStructure(buffer.byteLength >= 16, 'pdf too short');
  assertStructure(buffer.subarray(0, 5).toString('ascii') === '%PDF-', 'pdf header');
  assertStructure(/^%PDF-[12]\.\d/.test(buffer.subarray(0, 8).toString('latin1')), 'pdf version');

  const eofIndex = buffer.lastIndexOf('%%EOF');
  assertStructure(eofIndex >= 0, 'pdf eof');
  assertStructure(
    /^[\s\0]*$/.test(buffer.subarray(eofIndex + 5).toString('latin1')),
    'pdf trailing bytes',
  );

  const tailStart = Math.max(0, eofIndex - 4096);
  const tail = buffer.subarray(tailStart, eofIndex + 5).toString('latin1');
  const startxrefMatches = [...tail.matchAll(/startxref\s+(\d+)/g)];
  assertStructure(startxrefMatches.length > 0, 'pdf startxref');
  const startxrefOffset = Number(startxrefMatches[startxrefMatches.length - 1][1]);
  assertStructure(
    Number.isSafeInteger(startxrefOffset) &&
      startxrefOffset >= 0 &&
      startxrefOffset < buffer.byteLength,
    'pdf startxref range',
  );

  const xrefWindow = buffer
    .subarray(startxrefOffset, Math.min(buffer.byteLength, startxrefOffset + 32))
    .toString('latin1')
    .trimStart();
  const xrefIsTable = xrefWindow.startsWith('xref');
  const xrefIsStream = /^\d+\s+\d+\s+obj\b/.test(xrefWindow);
  assertStructure(xrefIsTable || xrefIsStream, 'pdf xref target');

  if (xrefIsTable) {
    assertStructure(buffer.includes('trailer'), 'pdf trailer');
  } else {
    const streamWindow = buffer
      .subarray(startxrefOffset, Math.min(buffer.byteLength, startxrefOffset + 2048))
      .toString('latin1');
    assertStructure(streamWindow.includes('/XRef'), 'pdf xref stream type');
  }

  assertStructure(buffer.includes('endobj'), 'pdf object body');
}

/* --------------------------------- PNG ----------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAX_CHUNKS = 10000;

export function isPngStructureValid(buffer: Buffer): boolean {
  return isValidWith(() => validatePng(buffer));
}

function validatePng(buffer: Buffer): void {
  assertStructure(buffer.byteLength >= PNG_SIGNATURE.byteLength + 12, 'png too short');
  assertStructure(buffer.subarray(0, 8).equals(PNG_SIGNATURE), 'png signature');

  let cursor = 8;
  let chunkCount = 0;
  let sawHeader = false;
  let imageDataChunks = 0;
  let sawEnd = false;

  while (cursor < buffer.byteLength) {
    assertStructure(cursor + 12 <= buffer.byteLength, 'png chunk header bounds');
    const length = buffer.readUInt32BE(cursor);
    assertStructure(length <= buffer.byteLength - cursor - 12, 'png chunk length bounds');
    const type = buffer.subarray(cursor + 4, cursor + 8).toString('ascii');
    assertStructure(/^[A-Za-z]{4}$/.test(type), 'png chunk type');
    const chunkEnd = cursor + 12 + length;
    assertStructure(chunkEnd <= buffer.byteLength, 'png chunk data bounds');

    const expectedCrc = buffer.readUInt32BE(cursor + 8 + length);
    const actualCrc = crc32(buffer.subarray(cursor + 4, cursor + 8 + length));
    assertStructure(actualCrc >>> 0 === expectedCrc, 'png chunk crc');

    if (!sawHeader) {
      assertStructure(type === 'IHDR' && length === 13, 'png first chunk');
      validatePngHeader(buffer.subarray(cursor + 8, cursor + 8 + length));
      sawHeader = true;
    } else if (type === 'IHDR') {
      throw new InvalidStructureError('png duplicate header');
    } else if (type === 'IDAT') {
      imageDataChunks += 1;
    } else if (type === 'IEND') {
      assertStructure(length === 0, 'png end chunk size');
      assertStructure(chunkEnd === buffer.byteLength, 'png trailing bytes');
      sawEnd = true;
      break;
    }

    chunkCount += 1;
    assertStructure(chunkCount <= PNG_MAX_CHUNKS, 'png chunk budget');
    cursor = chunkEnd;
  }

  assertStructure(sawHeader, 'png header');
  assertStructure(imageDataChunks > 0, 'png image data');
  assertStructure(sawEnd, 'png end chunk');
}

function validatePngHeader(header: Buffer): void {
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const compression = header[10];
  const filter = header[11];
  const interlace = header[12];
  assertStructure(width > 0 && height > 0, 'png dimensions');
  assertStructure([1, 2, 4, 8, 16].includes(bitDepth), 'png bit depth');
  assertStructure([0, 2, 3, 4, 6].includes(colorType), 'png color type');
  assertStructure(compression === 0 && filter === 0, 'png compression/filter');
  assertStructure(interlace === 0 || interlace === 1, 'png interlace');
}

/* --------------------------------- JPEG ---------------------------------- */

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_MAX_SEGMENTS = 10000;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function isJpegStructureValid(buffer: Buffer): boolean {
  return isValidWith(() => validateJpeg(buffer));
}

function validateJpeg(buffer: Buffer): void {
  assertStructure(buffer.byteLength >= 4, 'jpeg too short');
  assertStructure(buffer[0] === 0xff && buffer[1] === JPEG_SOI, 'jpeg soi');

  let cursor = 2;
  let sawFrame = false;

  for (let segmentCount = 0; segmentCount < JPEG_MAX_SEGMENTS; segmentCount += 1) {
    assertStructure(cursor + 2 <= buffer.byteLength, 'jpeg marker bounds');
    assertStructure(buffer[cursor] === 0xff, 'jpeg marker prefix');
    let markerOffset = cursor + 1;
    while (markerOffset < buffer.byteLength && buffer[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    assertStructure(markerOffset < buffer.byteLength, 'jpeg marker value');
    const marker = buffer[markerOffset];
    cursor = markerOffset + 1;

    assertStructure(marker !== JPEG_EOI, 'jpeg eoi before scan');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    assertStructure(cursor + 2 <= buffer.byteLength, 'jpeg segment length bounds');
    const segmentLength = buffer.readUInt16BE(cursor);
    assertStructure(segmentLength >= 2, 'jpeg segment length');
    const segmentEnd = cursor + segmentLength;
    assertStructure(segmentEnd <= buffer.byteLength, 'jpeg segment bounds');

    if (JPEG_SOF_MARKERS.has(marker)) {
      assertStructure(segmentLength >= 8, 'jpeg frame header length');
      const height = buffer.readUInt16BE(cursor + 3);
      const width = buffer.readUInt16BE(cursor + 5);
      assertStructure(width > 0 && height > 0, 'jpeg dimensions');
      sawFrame = true;
    }

    if (marker === JPEG_SOS) {
      assertStructure(sawFrame, 'jpeg scan before frame');
      assertStructure(findJpegEndOfImage(buffer, segmentEnd), 'jpeg end of image');
      return;
    }

    cursor = segmentEnd;
  }

  throw new InvalidStructureError('jpeg segment budget');
}

function findJpegEndOfImage(buffer: Buffer, start: number): boolean {
  for (let cursor = start; cursor + 1 < buffer.byteLength; cursor += 1) {
    if (buffer[cursor] !== 0xff) {
      continue;
    }
    const marker = buffer[cursor + 1];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      cursor += 1;
      continue;
    }
    if (marker === JPEG_EOI) {
      return true;
    }
  }
  return false;
}
