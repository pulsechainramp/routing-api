import fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';

import { PrismaClient } from './generated/prisma-client';
import { Logger } from './utils/logger';
import { ProxyManager } from './services/ProxyManager';
import { RateLimiter } from './services/RateLimiter';
import { PiteasService } from './services/PiteasService';
import { ChangeNowService } from './services/ChangeNowService';
import { OmniBridgeService } from './services/OmniBridgeService';
import { OmniBridgeTransactionService } from './services/OmniBridgeTransactionService';
import { BlockchainService } from './services/BlockchainService';
import { RateService } from './services/RateService';
import { TransactionService } from './services/TransactionService';
import { ReferralService } from './services/ReferralService';
import { ReferralFeeService } from './services/ReferralFeeService';
import { IndexerManager } from './services/IndexerManager';
import { RouteRegistry } from './routes/registry';
import { PulseXQuoteService } from './services/PulseXQuoteService';
import { AuthService } from './services/AuthService';
import { ReferralPaymentService } from './services/ReferralPaymentService';
import { getPulsechainProvider, initializePulsechainRpcProvider } from './providers/pulsechainRpcProvider';
import { getEthereumProvider, initializeEthereumRpcProvider } from './providers/ethereumRpcProvider';
import { setPulsechainProviderForWeb3 } from './utils/web3';

import dotenv from 'dotenv';
import config from './config';
import { setupSwagger } from './plugins/swagger';
import { getClientIp } from './utils/network';

// Load environment variables
dotenv.config();

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const PORT = Number(process.env.PORT ?? 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-jwt-secret-change-me';
const ENABLE_SWAGGER = process.env.ENABLE_SWAGGER === 'true';
const TRUST_PROXY = resolveTrustProxy(process.env.TRUST_PROXY);

function resolveTrustProxy(value?: string): boolean | number | string | string[] {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }

  const asNumber = Number(trimmed);
  if (!Number.isNaN(asNumber)) {
    return asNumber;
  }

  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      return parts;
    }
    if (parts.length === 1) {
      return parts[0];
    }
  }

  return trimmed;
}

// Comma-separated list of allowed origins, e.g.
// CORS_ALLOWLIST="https://app.example.com,https://admin.example.com"
const ALLOWLIST = (process.env.CORS_ALLOWLIST ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const logger = new Logger('App');
const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Redact common secret locations from logs
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'config.proxies[*].password',
        'process.env.CHANGENOW_API_KEY',
        'process.env.DATABASE_URL',
        'process.env.PROXY_PASSWORD',
      ],
      remove: true,
    },
  },
  trustProxy: TRUST_PROXY,
  bodyLimit: 512 * 1024, // 512KB body limit to prevent DoS
  maxParamLength: 1024, // 1KB max parameter length
});

// Initialize Prisma
const prisma = new PrismaClient();

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

// Initialize services
const proxyManager = new ProxyManager(
  (process.env.PROXY_LIST || '').split(','),
  process.env.PROXY_USERNAME,
  process.env.PROXY_PASSWORD
);

const rateLimiter = new RateLimiter(
  parseInt(process.env.RATE_LIMIT_REQUESTS || '10', 10),
  parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10)
);

const changeNowService = new ChangeNowService();
const omniBridgeService = new OmniBridgeService();
const rateService = new RateService(prisma);
const transactionService = new TransactionService(prisma);
const referralService = new ReferralService(prisma);
const referralFeeService = new ReferralFeeService(prisma);
const authService = new AuthService();

// ---- Security headers (Helmet) ----------------------------------------------
// NOTE: Default CSP can break some UIs; start with CSP disabled and tune later.
app.register(fastifyHelmet, {
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hidePoweredBy: true,
});

// ---- Global Rate Limiting ------------------------------------------------
app.register(rateLimit, {
  max: Number(process.env.RL_POINTS ?? 200),
  timeWindow: `${Number(process.env.RL_DURATION ?? 60)} seconds`,
  keyGenerator: (request: any) => getClientIp(request),
  errorResponseBuilder: (request: any, context: any) => ({
    error: 'Too Many Requests - Global rate limit exceeded',
    requestId: request.id,
    retryAfter: Math.round(context.ttl / 1000),
  }),
});

// ---- CORS (lock to your frontends) ------------------------------------------
app.register(cors, {
  origin: (origin, cb) => {
    // Allow non-browser clients (no Origin header), and allowed origins
    if (!origin) return cb(null, true);
    if (ALLOWLIST.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: false,
});

// ---- Swagger (explicit opt-in only) -----------------------------------------
setupSwagger(app, {
  enabled: ENABLE_SWAGGER,
  routePrefix: '/docs',
});

// ---- JWT Authentication -----------------------------------------------------
app.register(fastifyJwt, {
  secret: JWT_SECRET,
  sign: {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1h'
  }
});

app.decorate('authenticate', async function (request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.warn({ err }, 'JWT verification failed');
    return reply.status(401).send({ error: 'Unauthorized' });
  }
});

// ---- Global error handler (no leaky details) --------------------------------
app.setErrorHandler((err: any, req, reply) => {
  // Preserve explicit HTTP status if present; otherwise 500
  const status =
    typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  // Classify validation errors from Fastify/ajv
  const isValidation =
    err?.validation ||
    err?.code === 'FST_ERR_VALIDATION' ||
    (Array.isArray(err?.errors) && err.name === 'ValidationError');

  // Log full error server-side, but return a generic message to clients
  req.log.error({ err, requestId: req.id }, 'request_error');

  const message =
    isValidation ? 'Invalid request' :
    status >= 500 ? 'Internal Server Error' :
    'Bad Request';

  // Never echo stack or internal error.message to clients
  reply
    .code(isValidation && status === 500 ? 400 : status)
    .type('application/json')
    .send({ error: message, requestId: req.id });
});

const start = async () => {
  try {
    await initializePulsechainRpcProvider();
    await initializeEthereumRpcProvider();

    const pulsechainProvider = getPulsechainProvider();
    const ethereumProvider = getEthereumProvider();
    setPulsechainProviderForWeb3(pulsechainProvider);

    const blockchainService = new BlockchainService(ethereumProvider, pulsechainProvider);
    const omniBridgeTransactionService = new OmniBridgeTransactionService(prisma, blockchainService);
    const piteasService = new PiteasService(
      process.env.PITEAS_API_BASE_URL || '',
      proxyManager,
      rateLimiter,
      pulsechainProvider
    );
    const pulseXQuoteService = new PulseXQuoteService(pulsechainProvider);
    const referralPaymentService = new ReferralPaymentService(pulsechainProvider);
    const indexerManager = new IndexerManager(
      prisma,
      pulsechainProvider,
      config.AffiliateRouterAddress
    );

    const routeRegistry = new RouteRegistry(app, {
      prisma,
      piteasService,
      changeNowService,
      omniBridgeService,
      omniBridgeTransactionService,
      rateService,
      transactionService,
      referralService,
      referralFeeService,
      pulseXQuoteService,
      authService,
      referralPaymentService
    });

    await routeRegistry.registerAllRoutes();

    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`Server listening on port ${PORT} (env=${NODE_ENV})`);

    logger.info('Starting referral fee indexer...');
    await indexerManager.startAllIndexers();
    logger.info('Referral fee indexer started successfully');
  } catch (err) {
    logger.error('Error starting server', { error: err });
    process.exit(1);
  }
};

start();

// Start server
