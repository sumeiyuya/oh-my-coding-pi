import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 极小的密钥存储：只存“视觉服务 API key”这类应用级凭据。
 * 用 Electron safeStorage 加密后落盘；系统不支持加密时拒绝保存（不写明文）。
 */
export class SecretStore {
  private readonly file: string;
  private cache: Record<string, string> | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.file)
        ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>)
        : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache ?? {}, null, 2) + "\n", "utf8");
  }

  isSupported(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  has(key: string): boolean {
    return Boolean(this.load()[key]);
  }

  get(key: string): string | null {
    const stored = this.load()[key];
    if (!stored) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }

  set(key: string, value: string): boolean {
    if (!this.isSupported() && value) return false;
    const map = this.load();
    if (!value) {
      delete map[key];
      this.persist();
      return true;
    }
    map[key] = safeStorage.encryptString(value).toString("base64");
    this.persist();
    return true;
  }

  clear(key: string): void {
    const map = this.load();
    delete map[key];
    this.persist();
  }

  /** 已保存的键名（不返回值）。用来在启动时给「不在配置层里但存过密钥」的 provider 注入。 */
  keys(): string[] {
    return Object.keys(this.load());
  }
}
