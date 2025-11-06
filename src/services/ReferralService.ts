import { randomInt } from 'crypto';
import { PrismaClient } from '../generated/prisma-client';
import { UserResponse, ReferralCodeByCodeResponse } from '../types/referral';

export class ReferralService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  private _generateReferralCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      const index = randomInt(chars.length);
      result += chars.charAt(index);
    }
    return result;
  }

  private async _generateUniqueReferralCode(): Promise<string> {
    let referralCode: string;
    let isUnique = false;

    while (!isUnique) {
      referralCode = this._generateReferralCode();
      const existing = await this.prisma.user.findUnique({
        where: { referralCode }
      });
      if (!existing) {
        isUnique = true;
      }
    }

    return referralCode!;
  }



  async getReferralCodeByAddress(address: string): Promise<UserResponse | null> {
    const normalizedAddress = address.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { address: normalizedAddress }
    });

    if (!user) {
      return null;
    }

    return this.toResponse(user);
  }

  async createReferralCode(address: string): Promise<{ user: UserResponse; created: boolean }> {
    const normalizedAddress = address.toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { address: normalizedAddress }
    });

    if (existing) {
      return {
        user: this.toResponse(existing),
        created: false
      };
    }

    const newReferralCode = await this._generateUniqueReferralCode();

    const user = await this.prisma.user.create({
      data: {
        address: normalizedAddress,
        referralCode: newReferralCode
      }
    });

    return {
      user: this.toResponse(user),
      created: true
    };
  }

  async getAddressByReferralCode(referralCode: string): Promise<ReferralCodeByCodeResponse | null> {
    const result = await this.prisma.user.findUnique({
      where: { referralCode }
    });

    if (!result) {
      return null;
    }

    return {
      address: result.address,
      referralCode: result.referralCode,
      createdAt: result.createdAt.toISOString()
    };
  }

  private toResponse(user: any): UserResponse {
    return {
      id: user.id,
      address: user.address,
      referralCode: user.referralCode,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    };
  }
}
