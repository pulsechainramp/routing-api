import { FastifyInstance } from 'fastify';
import { PrismaClient } from '../generated/prisma-client';
import { PiteasService } from '../services/PiteasService';
import { ChangeNowService } from '../services/ChangeNowService';
import { OmniBridgeService } from '../services/OmniBridgeService';
import { OmniBridgeTransactionService } from '../services/OmniBridgeTransactionService';
import { RateService } from '../services/RateService';
import { TransactionService } from '../services/TransactionService';
import { ReferralService } from '../services/ReferralService';
import { ReferralFeeService } from '../services/ReferralFeeService';
import { AuthService } from '../services/AuthService';
import { ReferralPaymentService } from '../services/ReferralPaymentService';


// Route imports
import healthRoutes from './health';
import quoteRoutes from './quote';
import * as changenowRoutes from './changenow';
import * as omnibridgeRoutes from './omnibridge';
import referralRoutes from './referral';
import referralFeeRoutes from './referralFees';
import { PulseXQuoteService } from '../services/PulseXQuoteService';
import onrampsRoutes from './onramps';
import authRoutes from './auth';
import tokenPriceRoutes from './tokenPrice';

export interface RouteDependencies {
  prisma: PrismaClient;
  piteasService: PiteasService;
  changeNowService: ChangeNowService;
  omniBridgeService: OmniBridgeService;
  omniBridgeTransactionService: OmniBridgeTransactionService;
  rateService: RateService;
  transactionService: TransactionService;
  referralService: ReferralService;
  referralFeeService: ReferralFeeService;
  pulseXQuoteService: PulseXQuoteService;
  authService: AuthService;
  referralPaymentService: ReferralPaymentService;
}

export class RouteRegistry {
  private fastify: FastifyInstance;
  private dependencies: RouteDependencies;

  constructor(fastify: FastifyInstance, dependencies: RouteDependencies) {
    this.fastify = fastify;
    this.dependencies = dependencies;
  }

  async registerAllRoutes(): Promise<void> {
    await this.registerAuthRoutes();
    await this.registerHealthRoutes();
    await this.registerPiteasRoutes();
    // await this.registerChangeNowRoutes();
    await this.registerOmniBridgeRoutes();
    await this.registerReferralRoutes();
    await this.registerReferralFeeRoutes();
    await this.registerOnrampsRoutes();
    await this.registerTokenPriceRoutes();
  }

  private async registerAuthRoutes(): Promise<void> {
    await this.fastify.register(authRoutes, {
      prefix: '/auth',
      authService: this.dependencies.authService
    });
  }

  private async registerHealthRoutes(): Promise<void> {
    await this.fastify.register(healthRoutes, {
      prefix: '/health',
      prisma: this.dependencies.prisma
    });
  }

  private async registerPiteasRoutes(): Promise<void> {
    await this.fastify.register(quoteRoutes, {
      prefix: '/quote',
      piteasService: this.dependencies.piteasService,
      pulseXQuoteService: this.dependencies.pulseXQuoteService
    });
  }

  // private async registerChangeNowRoutes(): Promise<void> {
  //   // Register all ChangeNow routes under /exchange/changenow prefix
  //   await this.fastify.register(changenowRoutes.rateRoutes, {
  //     prefix: '/exchange/changenow',
  //     changeNowService: this.dependencies.changeNowService,
  //     rateService: this.dependencies.rateService
  //   });

  //   await this.fastify.register(changenowRoutes.swapRoutes, {
  //     prefix: '/exchange/changenow',
  //     changeNowService: this.dependencies.changeNowService,
  //     transactionService: this.dependencies.transactionService
  //   });

  //   await this.fastify.register(changenowRoutes.statusRoutes, {
  //     prefix: '/exchange/changenow',
  //     transactionService: this.dependencies.transactionService,
  //     changeNowService: this.dependencies.changeNowService
  //   });
  // }

  private async registerOmniBridgeRoutes(): Promise<void> {
    // Register all OmniBridge routes under /exchange/omnibridge prefix
    await this.fastify.register(omnibridgeRoutes.rateRoutes, {
      prefix: '/exchange/omnibridge',
      omniBridgeService: this.dependencies.omniBridgeService
    });

    await this.fastify.register(omnibridgeRoutes.transactionRoutes, {
      prefix: '/exchange/omnibridge',
      omniBridgeTransactionService: this.dependencies.omniBridgeTransactionService
    });
  }

  private async registerReferralRoutes(): Promise<void> {
    // Register referral routes under /referral prefix
    await this.fastify.register(referralRoutes, {
      prefix: '/referral',
      referralService: this.dependencies.referralService,
      referralPaymentService: this.dependencies.referralPaymentService
    });
  }

  private async registerReferralFeeRoutes(): Promise<void> {
    // Register referral fee routes under /referral-fees prefix
    await this.fastify.register(referralFeeRoutes, {
      prefix: '/referral-fees',
      referralFeeService: this.dependencies.referralFeeService
    });
  }

  private async registerOnrampsRoutes(): Promise<void> {
    await this.fastify.register(onrampsRoutes, {
      prefix: '/onramps',
    });
  }

  private async registerTokenPriceRoutes(): Promise<void> {
    await this.fastify.register(tokenPriceRoutes, {
      prefix: '/token',
      pulseXQuoteService: this.dependencies.pulseXQuoteService,
    });
  }
} 
