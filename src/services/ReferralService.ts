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
      result += chars.charAt(Math.floor(Math.random() * chars.length));
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



  async getOrCreateReferralCode(address: string): Promise<UserResponse> {
    // Normalize address to lowercase for case-insensitive handling
    const normalizedAddress = address.toLowerCase();
    
    // Check if user already exists
    let user = await this.prisma.user.findUnique({
      where: { address: normalizedAddress }
    });

    if (!user) {
      // Generate new unique referral code
      const newReferralCode = await this._generateUniqueReferralCode();
      
      user = await this.prisma.user.create({
        data: {
          address: normalizedAddress,
          referralCode: newReferralCode
        }
      });
    }

    return {
      id: user.id,
      address: user.address,
      referralCode: user.referralCode,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
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
} 