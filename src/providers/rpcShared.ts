import { FallbackProvider, JsonRpcProvider, Network } from 'ethers';
import { Logger } from '../utils/logger';

export type SerializedError = {
  code?: unknown;
  status?: unknown;
  message?: string;
  shortMessage?: unknown;
};

export const serializeError = (error: unknown): SerializedError => {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  const err = error as any;
  return {
    code: err.code,
    status: err.status,
    message: err.message,
    shortMessage: err.shortMessage,
  };
};

export const parseNumericEnv = (
  keys: string[],
  fallback: number,
  logger: Logger,
  logKey: string
): number => {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
    logger.warn(logKey, { key, value: raw, fallback });
  }
  return fallback;
};

const matchesPattern = (value: unknown, pattern?: RegExp) =>
  typeof value === 'string' && !!pattern && pattern.test(value);

export type RpcErrorClassifierResult = {
  transient: boolean;
  rateLimited?: boolean;
};

export type RpcErrorClassifier = (error: any) => RpcErrorClassifierResult;

export type ErrorClassifierOptions = {
  transientCodes: Set<string>;
  transientMessagePattern: RegExp;
  rateLimitMessagePattern?: RegExp;
  rateLimitStatusCodes?: number[];
};

export const createDefaultClassifier = ({
  transientCodes,
  transientMessagePattern,
  rateLimitMessagePattern,
  rateLimitStatusCodes = [429],
}: ErrorClassifierOptions): RpcErrorClassifier => {
  return (error: any) => {
    if (!error || typeof error !== 'object') {
      return { transient: false, rateLimited: false };
    }

    let transient = false;
    let rateLimited = false;

    if (typeof error.code === 'string' && transientCodes.has(error.code)) {
      transient = true;
    }

    if (matchesPattern((error as any).shortMessage, transientMessagePattern)) {
      transient = true;
    } else if (matchesPattern((error as any).message, transientMessagePattern)) {
      transient = true;
    }

    if (typeof error.status === 'number' && rateLimitStatusCodes.includes(error.status)) {
      transient = true;
      rateLimited = true;
    }

    if (typeof error.code === 'string' && matchesPattern(error.code, rateLimitMessagePattern)) {
      transient = true;
      rateLimited = true;
    }

    if (matchesPattern((error as any).shortMessage, rateLimitMessagePattern)) {
      transient = true;
      rateLimited = true;
    } else if (matchesPattern((error as any).message, rateLimitMessagePattern)) {
      transient = true;
      rateLimited = true;
    }

    return { transient, rateLimited };
  };
};

const createCooldownError = (url: string) => {
  const error = new Error(`RPC provider ${url} is in cooldown`);
  (error as any).code = 'RPC_COOLDOWN';
  return error;
};

type CircuitBreakerOptions = {
  network: Network;
  stallTimeoutMs: number;
  cooldownMs: number;
  rateLimitCooldownMs?: number;
  logger: Logger;
  logKey: string;
  classifier: RpcErrorClassifier;
};

export class CircuitBreakerJsonRpcProvider extends JsonRpcProvider {
  private failedUntil = 0;

  constructor(private readonly rpcUrl: string, private readonly options: CircuitBreakerOptions) {
    super(rpcUrl, options.network);
  }

  override _getConnection() {
    const connection = super._getConnection();
    if (this.options.stallTimeoutMs > 0) {
      connection.timeout = this.options.stallTimeoutMs;
    }
    return connection;
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const now = Date.now();
    if (now < this.failedUntil) {
      this.options.logger.warn(`${this.options.logKey}.cooldown.active`, {
        url: this.rpcUrl,
        method,
        retryInMs: this.failedUntil - now,
      });
      throw createCooldownError(this.rpcUrl);
    }

    const startedAt = now;

    try {
      const result = await super.send(method, params);
      if (this.failedUntil !== 0) {
        this.failedUntil = 0;
        this.options.logger.info(`${this.options.logKey}.recovered`, { url: this.rpcUrl });
      }
      return result;
    } catch (error: any) {
      const { transient, rateLimited } = this.options.classifier(error);
      if (transient) {
        const cooldownDuration =
          rateLimited && this.options.rateLimitCooldownMs
            ? this.options.rateLimitCooldownMs
            : this.options.cooldownMs;
        this.failedUntil = Date.now() + cooldownDuration;
        this.options.logger.warn(`${this.options.logKey}.fail`, {
          url: this.rpcUrl,
          method,
          elapsedMs: Date.now() - startedAt,
          cooldownMs: cooldownDuration,
          rateLimited: Boolean(rateLimited),
          error: serializeError(error),
        });
      }
      throw error;
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RetryingFallbackOptions = {
  attempts: number;
  retryDelayMs: number;
  quorum?: number;
  logger: Logger;
  logKey: string;
  classifier: RpcErrorClassifier;
  fallbackErrorMessage: string;
};

export class RetryingFallbackProvider extends FallbackProvider {
  constructor(
    configs: ConstructorParameters<typeof FallbackProvider>[0],
    network: Network,
    private readonly options: RetryingFallbackOptions
  ) {
    super(configs, network, { quorum: options.quorum ?? 1 });
  }

  override async _perform(req: any): Promise<any> {
    let lastError: any = new Error(this.options.fallbackErrorMessage);

    for (let attempt = 0; attempt <= this.options.attempts; attempt++) {
      try {
        return await super._perform(req);
      } catch (error: any) {
        lastError = error;
        const classification = this.options.classifier(error);
        const transient = classification.transient || error?.code === 'RPC_COOLDOWN';
        if (!transient || attempt === this.options.attempts) {
          throw error;
        }

        this.options.logger.warn(`${this.options.logKey}.retry`, {
          method: req?.method,
          attempt: attempt + 1,
          maxAttempts: this.options.attempts + 1,
          error: serializeError(error),
        });

        if (this.options.retryDelayMs > 0) {
          await delay(this.options.retryDelayMs);
        }
      }
    }

    throw lastError;
  }
}

export type ProviderEntry<T extends JsonRpcProvider = JsonRpcProvider> = {
  url: string;
  provider: T;
};

type ValidateProvidersOptions<T extends JsonRpcProvider> = {
  entries: ProviderEntry<T>[];
  expectedChainId: number;
  logger: Logger;
  logKey: string;
  failureMessage: string;
  extraCheck?: (provider: T, url: string) => Promise<void>;
};

export const validateRpcProviders = async <T extends JsonRpcProvider>({
  entries,
  expectedChainId,
  logger,
  logKey,
  failureMessage,
  extraCheck,
}: ValidateProvidersOptions<T>): Promise<ProviderEntry<T>[]> => {
  const results = await Promise.allSettled(
    entries.map(async ({ provider, url }) => {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== expectedChainId) {
        throw new Error(`RPC ${url} returned chainId ${network.chainId}`);
      }

      if (extraCheck) {
        await extraCheck(provider, url);
      }
    })
  );

  const healthyEntries = entries.filter((_, index) => results[index].status === 'fulfilled');

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn(`${logKey}.validate.fail`, {
        url: entries[index]?.url,
        error: serializeError(result.reason),
      });
    }
  });

  const attemptedUrls = entries.map((entry) => entry.url);
  const failureDetails = results
    .map((result, index) => {
      const url = entries[index]?.url ?? 'unknown';
      if (result.status === 'rejected') {
        const errorSummary = serializeError(result.reason);
        return `${url}: ${errorSummary?.message ?? JSON.stringify(errorSummary)}`;
      }
      return `${url}: healthy`;
    })
    .join('; ');

  if (healthyEntries.length === 0) {
    throw new Error(
      `${failureMessage} Attempted: ${
        attemptedUrls.length > 0 ? attemptedUrls.join(', ') : 'none'
      }. Failure details: ${failureDetails || 'none'}`
    );
  }

  if (healthyEntries.length !== entries.length) {
    const dropped = entries
      .filter((_, index) => results[index].status === 'rejected')
      .map((entry) => entry.url);
    logger.warn(`${logKey}.validate.pruned`, { dropped });
  }

  logger.info(`${logKey}.validate.success`, {
    urls: healthyEntries.map((entry) => entry.url),
    healthy: healthyEntries.length,
  });

  return healthyEntries;
};
