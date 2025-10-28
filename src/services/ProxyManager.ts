import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Logger } from '../utils/logger';

interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  url: string;
}

export class ProxyManager {
  private proxies: ProxyConfig[];
  private currentIndex: number = 0;
  private logger: Logger;
  private enabled: boolean;

  constructor(proxyList: string[], username?: string, password?: string) {
    this.logger = new Logger('ProxyManager');
    // Normalize and validate proxies list (ignore empty/invalid entries)
    const normalized = (proxyList || [])
      .map(p => (p || '').trim())
      .filter(p => p.length > 0 && p.includes(':'));

    this.proxies = normalized.map(proxy => {
      const [host, portStr] = proxy.split(':');
      const port = parseInt(portStr || '', 10);
      return {
        host,
        port: Number.isFinite(port) ? port : 0,
        username,
        password,
        url: proxy
      };
    });

    // Determine if proxying is enabled
    // Priority: explicit USE_PROXY env -> presence of valid proxies
    const envVal = (process.env.USE_PROXY || '').toLowerCase();
    const envEnabled = envVal === 'true' ? true : envVal === 'false' ? false : undefined;
    this.enabled = envEnabled !== undefined ? envEnabled : this.proxies.length > 0;
  }

  public getNextProxy(): ProxyConfig {
    if (!this.enabled || this.proxies.length === 0) {
      return { host: '', port: 0, url: 'direct' } as ProxyConfig;
    }
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }

  public getCurrentProxy(): ProxyConfig {
    if (!this.enabled || this.proxies.length === 0) {
      return { host: '', port: 0, url: 'direct' } as ProxyConfig;
    }
    return this.proxies[this.currentIndex];
  }

  public createAxiosInstance(): AxiosInstance {
    if (!this.enabled || this.proxies.length === 0) {
      this.logger.info('Proxy disabled; using direct connection');
      return axios.create();
    }
    const proxy = this.getNextProxy();
    const authPart = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    const proxyUrl = `http://${authPart}${proxy.host}:${proxy.port}`;

    this.logger.info(`Using proxy: ${proxy.host}:${proxy.port}`);

    return axios.create({
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    });
  }

  public getProxyCount(): number {
    return this.proxies.length;
  }
} 