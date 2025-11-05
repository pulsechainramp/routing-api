import { PrismaClient } from '../generated/prisma-client';
import { ReferralFeeResponse, ReferralFeeUpdateEvent } from '../types/referral';
import { ethers } from 'ethers';
import AffiliateRouterArtifact from '../abis/AffiliateRouter.json';
import { formatTokenAmount } from '../utils/web3';

export class ReferralFeeService {
  private prisma: PrismaClient;
  private affiliateRouterInterface: ethers.Interface;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    const abi = (AffiliateRouterArtifact as { abi: ethers.InterfaceAbi }).abi;
    this.affiliateRouterInterface = new ethers.Interface(abi);
  }





  /**
   * Process ReferralFeeAmountUpdated event and update database
   */
  async processReferralFeeEvent(event: ReferralFeeUpdateEvent): Promise<void> {
    try {
      // Format the amount using proper token decimals
      const formattedAmount = await formatTokenAmount(event.amount, event.token);
      
      console.log(`Formatting referral fee: Raw amount: ${event.amount}, Token: ${event.token}, Formatted: ${formattedAmount}`);
      
      // Upsert referral fee record
      await this.prisma.referralFee.upsert({
        where: {
          referrer_token: {
            referrer: event.referrer.toLowerCase(),
            token: event.token.toLowerCase()
          }
        },
        update: {
          amount: formattedAmount,
          lastUpdated: new Date(event.timestamp * 1000)
        },
        create: {
          referrer: event.referrer.toLowerCase(),
          token: event.token.toLowerCase(),
          amount: formattedAmount
        }
      });
    } catch (error) {
      console.error('Error processing referral fee event:', error);
      throw error;
    }
  }

  /**
   * Get referral fee for a specific referrer and token
   */
  async getReferralFee(referrer: string, token: string): Promise<ReferralFeeResponse | null> {
    try {
      const referralFee = await this.prisma.referralFee.findUnique({
        where: {
          referrer_token: {
            referrer: referrer.toLowerCase(),
            token: token.toLowerCase()
          }
        }
      });

      if (!referralFee) {
        return null;
      }

      return {
        id: referralFee.id,
        referrer: referralFee.referrer,
        token: referralFee.token,
        amount: referralFee.amount.toString(),
        lastUpdated: referralFee.lastUpdated.toISOString(),
        createdAt: referralFee.createdAt.toISOString()
      };
    } catch (error) {
      console.error('Error getting referral fee:', error);
      throw error;
    }
  }

  /**
   * Get all referral fees for a specific referrer
   */
  async getReferralFeesByReferrer(referrer: string): Promise<ReferralFeeResponse[]> {
    try {
      const referralFees = await this.prisma.referralFee.findMany({
        where: {
          referrer: referrer.toLowerCase()
        },
        orderBy: {
          lastUpdated: 'desc'
        }
      });

      return referralFees.map(fee => ({
        id: fee.id,
        referrer: fee.referrer,
        token: fee.token,
        amount: fee.amount.toString(),
        lastUpdated: fee.lastUpdated.toISOString(),
        createdAt: fee.lastUpdated.toISOString()
      }));
    } catch (error) {
      console.error('Error getting referral fees by referrer:', error);
      throw error;
    }
  }

  /**
   * Get all referral fees for a specific token
   */
  async getReferralFeesByToken(token: string): Promise<ReferralFeeResponse[]> {
    try {
      const referralFees = await this.prisma.referralFee.findMany({
        where: {
          token: token.toLowerCase()
        },
        orderBy: {
          lastUpdated: 'desc'
        }
      });

      return referralFees.map(fee => ({
        id: fee.id,
        referrer: fee.referrer,
        token: fee.token,
        amount: fee.amount.toString(),
        lastUpdated: fee.lastUpdated.toISOString(),
        createdAt: fee.createdAt.toISOString()
      }));
    } catch (error) {
      console.error('Error getting referral fees by token:', error);
      throw error;
    }
  }

  /**
   * Get total referral fees across all referrers and tokens
   */
  async getTotalReferralFees(): Promise<{ totalAmount: string; totalReferrers: number; totalTokens: number }> {
    try {
      const [totalAmount, totalReferrers, totalTokens] = await Promise.all([
        this.prisma.referralFee.aggregate({
          _sum: {
            amount: true
          }
        }),
        this.prisma.referralFee.groupBy({
          by: ['referrer'],
          _count: true
        }),
        this.prisma.referralFee.groupBy({
          by: ['token'],
          _count: true
        })
      ]);

      return {
        totalAmount: totalAmount._sum.amount?.toString() || '0',
        totalReferrers: totalReferrers.length,
        totalTokens: totalTokens.length
      };
    } catch (error) {
      console.error('Error getting total referral fees:', error);
      throw error;
    }
  }
} 
