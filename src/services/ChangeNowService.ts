import axios, { AxiosInstance } from 'axios';
import {
  Currency,
  ExchangeRange,
  EstimateResponse,
  TransactionResponse,
  TransactionStatus,
  CreateTransactionParams,
  EstimateParams,
} from '../types/changenow';

const DISABLED_MESSAGE = 'ChangeNOW integration is disabled (missing CHANGENOW_API_KEY)';

export class ChangeNowService {
  private client: AxiosInstance | null = null;
  private apiKey: string | null;
  private enabled: boolean;

  constructor() {
    this.apiKey = process.env.CHANGENOW_API_KEY ?? null;
    this.enabled = Boolean(this.apiKey);

    if (!this.enabled) {
      console.warn('ChangeNOW integration disabled: CHANGENOW_API_KEY not set');
      return;
    }

    this.client = axios.create({
      baseURL: 'https://api.changenow.io/v2',
      headers: {
        'x-changenow-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  private assertEnabled(): asserts this is { client: AxiosInstance } {
    if (!this.enabled || !this.client) {
      throw new Error(DISABLED_MESSAGE);
    }
  }

  async getSupportedCurrencies(params?: {
    active?: boolean;
    flow?: 'standard' | 'fixed-rate';
    buy?: boolean;
    sell?: boolean;
  }): Promise<Currency[]> {
    this.assertEnabled();
    try {
      const response = await this.client.get('/exchange/currencies', { params });
      return response.data;
    } catch (error) {
      console.error('Failed to get supported currencies:', error);
      throw new Error('Failed to fetch supported currencies');
    }
  }

  async getExchangeRange(
    fromCurrency: string,
    toCurrency: string,
    fromNetwork?: string,
    toNetwork?: string,
    flow: 'standard' | 'fixed-rate' = 'standard',
  ): Promise<ExchangeRange> {
    this.assertEnabled();
    try {
      const params = {
        fromCurrency,
        toCurrency,
        fromNetwork,
        toNetwork,
        flow,
      };

      const response = await this.client.get('/exchange/range', { params });
      return response.data;
    } catch (error) {
      console.error('Failed to get exchange range:', error);
      throw new Error('Failed to fetch exchange range');
    }
  }

  async getEstimatedAmount(params: EstimateParams): Promise<EstimateResponse> {
    this.assertEnabled();
    try {
      const response = await this.client.get('/exchange/estimated-amount', { params });
      return response.data;
    } catch (error) {
      console.error('Failed to get estimated amount:', error);
      throw new Error('Failed to fetch estimate');
    }
  }

  async createTransaction(params: CreateTransactionParams): Promise<TransactionResponse> {
    this.assertEnabled();
    try {
      const response = await this.client.post('/exchange', params);
      return response.data;
    } catch (error) {
      console.error('Failed to create transaction:', error);
      throw new Error('Failed to create transaction');
    }
  }

  async getTransactionStatus(id: string): Promise<TransactionStatus> {
    this.assertEnabled();
    try {
      const response = await this.client.get(`/exchange/by-id`, { params: { id } });
      return response.data;
    } catch (error) {
      console.error('Failed to get transaction status:', error);
      throw new Error('Failed to fetch transaction status');
    }
  }

  async getMinAmount(
    fromCurrency: string,
    toCurrency: string,
    fromNetwork?: string,
    toNetwork?: string,
    flow: 'standard' | 'fixed-rate' = 'standard',
  ): Promise<{ minAmount: number }> {
    this.assertEnabled();
    try {
      const params = {
        fromCurrency,
        toCurrency,
        fromNetwork,
        toNetwork,
        flow,
      };

      const response = await this.client.get('/exchange/min-amount', { params });
      return response.data;
    } catch (error) {
      console.error('Failed to get min amount:', error);
      throw new Error('Failed to fetch minimum amount');
    }
  }
}
