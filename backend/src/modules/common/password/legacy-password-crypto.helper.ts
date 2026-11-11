// src/modules/common/password/legacy-password-crypto.helper.ts
import {
  hashPasswordWithSalt,
  verifyPasswordWithSalt,
} from '@core/account/policy/password-hashing.policy';
// import * as CryptoJS from 'crypto-js';

/**
 * 老系统兼容密码加密工具类
 * 提供与老系统兼容的 PBKDF2 密码哈希功能
 */
export class LegacyPasswordCryptoHelper {
  /**
   * 根据传入的密码和盐值生成哈希字符串（Node.js crypto 版本）
   * 算法实现已下沉到 core，避免登录、管理员初始化与历史调用各自维护一份 PBKDF2。
   * @param password - 用户的密码
   * @param salt - 用于加密的盐值
   * @returns 返回加密后的哈希字符串
   */
  static hashPasswordWithCrypto(password: string, salt: string): string {
    return hashPasswordWithSalt(password, salt);
  }

  /**
   * 验证密码是否正确（使用 Node.js crypto 版本）
   * 使用常量时间比较避免计时侧信道攻击
   * @param password - 待验证的密码
   * @param salt - 盐值
   * @param hashedPassword - 已存储的哈希密码
   * @returns 密码是否匹配
   */
  static verifyPasswordWithCrypto(password: string, salt: string, hashedPassword: string): boolean {
    return verifyPasswordWithSalt(password, salt, hashedPassword);
  }

  /**
   * 根据传入的密码和盐值生成哈希字符串（CryptoJS 版本）
   * 完全复刻老系统的 CryptoJS.PBKDF2 实现
   * @param password - 用户的密码
   * @param salt - 用于加密的盐值
   * @returns 返回加密后的哈希字符串
   */
  // static hashPassword(password: string, salt: string): string {
  //   // 使用与老系统完全相同的 CryptoJS.PBKDF2 实现
  //   const saltStr = salt.toString();
  //   const hash = CryptoJS.PBKDF2(password, saltStr, {
  //     keySize: 64 / 4, // 64 字节等于 512 位，而 keySize 以 32 位字为单位，64 字节等于 16 个字
  //     iterations: 5000,
  //     hasher: CryptoJS.algo.SHA256,
  //   }).toString(CryptoJS.enc.Hex);
  //   return hash;
  // }
}
