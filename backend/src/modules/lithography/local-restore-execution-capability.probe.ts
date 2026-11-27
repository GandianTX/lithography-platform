// src/modules/lithography/local-restore-execution-capability.probe.ts
/**
 * 恢复执行能力的**真实探测实现**（任务 09 S4；review 遗留 L1）。
 *
 * 为什么此前是缺口：`RESTORE_EXECUTION_CAPABILITY` 端口**从未被注册**，
 * 于是能力查询用例按「三项闸门全部未就绪」如实返回「不可用」——
 * 而恢复执行链本身**是可用的**（受理/执行不依赖该端口）。
 * 结果是：页面上恒显示「恢复执行不可用」（假阴性），运维无法用该入口判断环境，
 * 同一问题还出现「能不能恢复」两个答案（查询链 vs 执行链）。
 *
 * 本实现只回答**环境级**事实（本机现在具备不具备恢复执行的前提），
 * 与执行链的**单次恢复级**事实（本次恢复的保护副本是否就绪）是两个维度：
 * - 环境级：安装身份已初始化？恢复写回端口已注册？保护密钥材料可解析？
 * - 单次级：本次恢复的保护副本资产是否还在？（执行链自己判断）
 *
 * 纪律：探测失败一律按「未就绪」处理（失败关闭），不因探测异常把不可用说成可用。
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { parseProtectionKey } from '@core/local-runtime/policy/protected-backup.policy';

import {
  LOCAL_BACKUP_PROTECTION,
  type ProtectedBackupMaterial,
} from '@usecases/common/ports/protected-backup.contract';
import {
  LOCAL_RESTORE_RECORD_WRITER,
  type LocalRestoreRecordWriter,
} from '@usecases/common/ports/local-restore-record-writer.contract';
import {
  RESTORE_EXECUTION_CAPABILITY,
  type RestoreExecutionCapabilityProbe,
  type RestoreExecutionCapabilityReport,
} from '@usecases/common/ports/restore-execution-capability.contract';

import { LocalInstallationEntity } from './entities/local-installation.entity';

@Injectable()
export class LocalRestoreExecutionCapabilityProbe implements RestoreExecutionCapabilityProbe {
  constructor(
    @InjectRepository(LocalInstallationEntity)
    private readonly installationRepository: Repository<LocalInstallationEntity>,
    @Optional()
    @Inject(LOCAL_RESTORE_RECORD_WRITER)
    private readonly recordWriter?: LocalRestoreRecordWriter,
    @Optional()
    @Inject(LOCAL_BACKUP_PROTECTION)
    private readonly backupProtection?: ProtectedBackupMaterial | null,
  ) {}

  async probe(): Promise<RestoreExecutionCapabilityReport> {
    return {
      writeGateReady: await this.isWriteGateReady(),
      failureCompensationReady: this.isFailureCompensationReady(),
      protectionKeyReady: this.isProtectionKeyReady(),
    };
  }

  /**
   * 写入/同步闸门是否就绪。
   *
   * 前提是**本机安装身份已初始化**：没有安装身份就无法圈定本机与公司的数据区，
   * 冻结闸门无从建立（`LocalWriteHoldService` 在身份缺失时直接失败关闭）。
   */
  private async isWriteGateReady(): Promise<boolean> {
    try {
      const installation = await this.installationRepository.findOne({ where: { id: 1 } });
      return installation !== null && installation.installationId.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 失败回滚补偿是否就绪。
   *
   * 回滚＝按**保护副本**再走一次写回链路 ⇒ 恢复写回端口必须已注册。
   * （端口未注册时恢复链本身也会逐项失败关闭。）
   */
  private isFailureCompensationReady(): boolean {
    return this.recordWriter !== undefined && this.recordWriter !== null;
  }

  /** 受保护包解密材料是否可得（材料存在且可解析） */
  private isProtectionKeyReady(): boolean {
    try {
      return parseProtectionKey(this.backupProtection?.keyHex ?? null) !== null;
    } catch {
      return false;
    }
  }
}

/** 供装配层引用：能力探测端口的注入令牌 */
export { RESTORE_EXECUTION_CAPABILITY };
