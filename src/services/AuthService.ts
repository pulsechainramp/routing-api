import { randomBytes } from 'crypto';

interface NonceRecord {
  address: string;
  clientId: string;
  expiresAt: number;
}

export class AuthService {
  private readonly nonceTtlMs: number;
  private readonly nonces = new Map<string, NonceRecord>();

  constructor(ttlMs = 5 * 60 * 1000) {
    this.nonceTtlMs = ttlMs;
  }

  generateNonce(address: string, clientId: string): string {
    this.cleanupExpiredNonces();
    const nonce = randomBytes(16).toString('hex');
    const normalized = this.normalizeAddress(address);
    this.nonces.set(nonce, {
      address: normalized,
      clientId,
      expiresAt: Date.now() + this.nonceTtlMs,
    });
    return nonce;
  }

  consumeNonce(nonce: string, address: string, clientId: string): boolean {
    this.cleanupExpiredNonces();
    const normalized = this.normalizeAddress(address);
    const record = this.nonces.get(nonce);
    if (!record) {
      return false;
    }

    if (
      record.address !== normalized ||
      record.clientId !== clientId ||
      record.expiresAt < Date.now()
    ) {
      this.nonces.delete(nonce);
      return false;
    }

    this.nonces.delete(nonce);
    return true;
  }

  private cleanupExpiredNonces(): void {
    const now = Date.now();
    for (const [nonce, record] of this.nonces.entries()) {
      if (record.expiresAt < now) {
        this.nonces.delete(nonce);
      }
    }
  }

  private normalizeAddress(address: string): string {
    return address.toLowerCase();
  }
}
