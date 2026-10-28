// test/11-content-submission/attachment-storage-barrier.ts
//
// PR0-S8 剩余三项 N03：测试专用投稿附件存储委托（仅测试层，不进入生产 src/）。
//
// - open/save/delete 全部转发真实本地存储实例：不伪造写入结果、不替换存储根；
// - 仅在本规格显式 activate 后记录「真实写入成功」的精确引用，并按模式阻塞 save 返回；
// - 默认 off：既有用例（V6/V7/V8/V9）行为与直接使用真实存储一致；
// - record：只记录引用，不阻塞（用于真实事务回滚场景的副本定位）；
// - single/dual：写入成功后阻塞，直到 releaseAll；用于把「副本已落盘但尚未进入审批事务」
//   变成确定性时序，而不是随机并发。

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { ContentSubmissionAttachmentStorage } from '@src/usecases/content-submission/content-submission-attachment-storage.contract';

/** 内容指纹：用于证明「真实写入的副本内容」与冻结原件一致（不依赖事后文件仍存在） */
export const sha256Hex = (content: Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

export type AttachmentBarrierMode = 'off' | 'record' | 'single' | 'dual';

type ArrivalWaiter = {
  readonly count: number;
  readonly notify: () => void;
};

type Gate = {
  readonly promise: Promise<void>;
  readonly release: () => void;
};

const createGate = (): Gate => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

export class BarrierAttachmentStorage implements ContentSubmissionAttachmentStorage {
  private readonly inner: ContentSubmissionAttachmentStorage;
  private mode: AttachmentBarrierMode = 'off';
  private savedReferences: string[] = [];
  private savedFingerprints: string[] = [];
  private arrivalWaiters: ArrivalWaiter[] = [];
  private gate: Gate | null = null;
  private heldSaves = 0;

  constructor(inner: ContentSubmissionAttachmentStorage) {
    this.inner = inner;
  }

  /** 已记录的真实副本引用（按写入成功顺序）；off 模式不记录 */
  get saved(): readonly string[] {
    return [...this.savedReferences];
  }

  /** 与 saved 同序的副本内容指纹（写入成功时计算）；off 模式不记录 */
  get fingerprints(): readonly string[] {
    return [...this.savedFingerprints];
  }

  /** 当前是否仍有 save 被屏障阻塞（收尾前置检查，防止挂起与跨场景残留） */
  get held(): number {
    return this.heldSaves;
  }

  /**
   * 启用指定模式。必须等上一场景完全释放：否则明确失败，
   * 不允许把悬挂的 save 带进下一个场景。
   */
  activate(mode: Exclude<AttachmentBarrierMode, 'off'>): void {
    if (this.mode !== 'off' || this.heldSaves !== 0) {
      throw new Error(
        `上一场景尚未释放，不能启用新屏障：mode=${this.mode}, heldSaves=${this.heldSaves}`,
      );
    }
    this.savedReferences = [];
    this.savedFingerprints = [];
    this.arrivalWaiters = [];
    this.gate = mode === 'record' ? null : createGate();
    this.mode = mode;
  }

  /**
   * 等待至少 count 个真实副本写入成功（有界超时；未到齐明确失败）。
   * 到齐只代表写入完成，不代表放行：调用方先断言文件可读，再 releaseAll。
   */
  async waitForSaved(count: number, timeoutMs = 15000): Promise<void> {
    if (this.savedReferences.length >= count) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ArrivalWaiter = {
        count,
        notify: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.arrivalWaiters = this.arrivalWaiters.filter((item) => item !== waiter);
        reject(
          new Error(
            `等待 ${count} 个真实副本落盘超时：已记录 ${this.savedReferences.length} 个` +
              `（${this.savedReferences.join(', ') || '无'}）`,
          ),
        );
      }, timeoutMs);
      this.arrivalWaiters.push(waiter);
    });
  }

  /** 统一放行并关闭屏障；幂等，供 finally 兜底 */
  releaseAll(): void {
    const gate = this.gate;
    this.gate = null;
    this.mode = 'off';
    this.arrivalWaiters = [];
    if (gate) {
      gate.release();
    }
  }

  async save(content: Buffer, fileExtension: string): Promise<string> {
    // 先让真实存储完成写入：记录与阻塞都发生在写入成功之后
    const reference = await this.inner.save(content, fileExtension);
    if (this.mode === 'off') {
      return reference;
    }
    this.savedReferences.push(reference);
    this.savedFingerprints.push(sha256Hex(content));
    this.notifyArrivals();
    if (this.mode === 'record') {
      return reference;
    }
    const gate = this.gate;
    if (gate === null) {
      throw new Error('屏障模式缺少放行门，拒绝在无界状态下阻塞实时写入');
    }
    this.heldSaves += 1;
    try {
      await gate.promise;
    } finally {
      this.heldSaves -= 1;
    }
    return reference;
  }

  open(storageReference: string): Promise<Readable> {
    return this.inner.open(storageReference);
  }

  delete(storageReference: string): Promise<void> {
    return this.inner.delete(storageReference);
  }

  private notifyArrivals(): void {
    const ready = this.arrivalWaiters.filter((item) => this.savedReferences.length >= item.count);
    this.arrivalWaiters = this.arrivalWaiters.filter(
      (item) => this.savedReferences.length < item.count,
    );
    ready.forEach((item) => item.notify());
  }
}
