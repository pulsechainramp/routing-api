import { Contract, type Provider } from 'ethers';
import MulticallAbi from '../abis/Multicall.json';
import { Logger } from './logger';
import type { Address } from '../types/pulsex';

export interface MulticallCall {
  target: Address;
  callData: string;
}

export interface MulticallResult {
  success: boolean;
  returnData: string;
}

export interface MulticallClientConfig {
  address: Address;
  enabled: boolean;
  maxBatchSize: number;
  timeoutMs: number;
}

export class MulticallClient {
  private readonly contract: Contract;
  private readonly logger: Logger;
  private readonly config: MulticallClientConfig;

  constructor(provider: Provider, config: MulticallClientConfig, logger?: Logger) {
    this.contract = new Contract(config.address, MulticallAbi, provider);
    this.config = {
      ...config,
      maxBatchSize: Math.max(1, config.maxBatchSize),
    };
    this.logger = logger ?? new Logger('Multicall');
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  public async execute(calls: MulticallCall[]): Promise<MulticallResult[]> {
    if (!this.config.enabled) {
      throw new Error('Multicall is disabled');
    }

    if (!calls.length) {
      return [];
    }

    const results: MulticallResult[] = [];
    const batchSize = Math.max(1, this.config.maxBatchSize);

    for (let i = 0; i < calls.length; i += batchSize) {
      const chunk = calls.slice(i, i + batchSize);

      const { value, timedOut } = await this.withTimeout(
        this.contract.multicall(chunk) as Promise<MulticallResult[]>,
        this.config.timeoutMs,
      );

      if (timedOut) {
        throw new Error('Multicall chunk timed out');
      }

      if (!value || !Array.isArray(value)) {
        throw new Error('Multicall returned an empty result set');
      }

      for (const entry of value) {
        results.push({
          success: Boolean(entry?.success),
          returnData: typeof entry?.returnData === 'string' ? entry.returnData : '0x',
        });
      }
    }

    return results;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<{ value: T | null; timedOut: boolean }> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    return Promise.race([
      promise
        .then((value) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          return { value, timedOut: false };
        })
        .catch((error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          this.logger.debug('Multicall execution failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          return { value: null, timedOut: false };
        }),
      new Promise<{ value: null; timedOut: boolean }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ value: null, timedOut: true }), timeoutMs);
      }),
    ]);
  }
}
