// src/infrastructure/field-encryption/field-encryption.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createFieldCipher, type FieldCipher } from './field-encryption.cipher';
import { getEncryptedFields } from './field-encryption.metadata';

const getRequiredConfig = (config: ConfigService, key: string): string => {
  const value = config.get<string>(key);
  if (!value || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
};

@Injectable()
export class FieldEncryptionService {
  private readonly cipher: FieldCipher;

  constructor(private readonly configService: ConfigService) {
    const key = getRequiredConfig(this.configService, 'FIELD_ENCRYPTION_KEY');
    const iv = getRequiredConfig(this.configService, 'FIELD_ENCRYPTION_IV');
    this.cipher = createFieldCipher(key, iv);
  }

  encrypt(plain: string): string {
    return this.cipher.encrypt(plain);
  }

  decrypt(cipher: string): string {
    return this.cipher.decrypt(cipher);
  }

  encryptEntity(entity: unknown) {
    if (typeof entity !== 'object' || entity === null) return;
    const fields = getEncryptedFields(entity.constructor);
    for (const field of fields) {
      const val = (entity as Record<string | symbol, unknown>)[field];

      if (typeof val === 'string' && val) {
        const encrypted = this.encrypt(val);
        (entity as Record<string | symbol, unknown>)[field] = encrypted;
      } else if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
        const jsonString = JSON.stringify(val);
        const encrypted = this.encrypt(jsonString);
        (entity as Record<string | symbol, unknown>)[field] = encrypted;
      }
    }
  }

  decryptEntity(entity: unknown) {
    if (typeof entity !== 'object' || entity === null) return;
    const fields = getEncryptedFields(entity.constructor);
    for (const field of fields) {
      const val = (entity as Record<string | symbol, unknown>)[field];

      if (typeof val === 'string' && val) {
        try {
          const decrypted = this.decrypt(val);
          try {
            const parsed: unknown = JSON.parse(decrypted);

            (entity as Record<string | symbol, unknown>)[field] = parsed;
          } catch {
            (entity as Record<string | symbol, unknown>)[field] = decrypted;
          }
        } catch {
          continue;
        }
      }
    }
  }
}
