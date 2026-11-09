// src/infrastructure/field-encryption/field-encryption.cipher.ts
import * as CryptoJS from 'crypto-js';

const FIELD_ENCRYPTION_META = {
  KEY_LENGTH: 16,
  IV_LENGTH: 16,
} as const;

export interface FieldCipher {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/**
 * 字段加密纯原语：与 `FieldEncryptionService` 共用同一 AES-CBC/Pkcs7 实现。
 *
 * `FieldEncryptionService` 依赖 Nest `ConfigService`，无法在迁移/部署脚本中直接实例化；
 * 本函数把加密算法本身下沉为无框架依赖的纯函数，供 `admin-bootstrap` 在写入
 * `base_user_info.meta_digest` 时复用，不另造平行加密方式。
 */
export function createFieldCipher(key: string, iv: string): FieldCipher {
  const keyWords = CryptoJS.lib.WordArray.create(
    CryptoJS.enc.Utf8.parse(key).words,
    FIELD_ENCRYPTION_META.KEY_LENGTH,
  );
  const ivWords = CryptoJS.lib.WordArray.create(
    CryptoJS.enc.Utf8.parse(iv).words,
    FIELD_ENCRYPTION_META.IV_LENGTH,
  );

  return {
    encrypt(plain: string): string {
      return CryptoJS.AES.encrypt(plain, keyWords, {
        iv: ivWords,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString();
    },
    decrypt(cipher: string): string {
      return CryptoJS.AES.decrypt(cipher, keyWords, {
        iv: ivWords,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).toString(CryptoJS.enc.Utf8);
    },
  };
}
