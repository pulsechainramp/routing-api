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

  constructor(proxyList: string[], username?: string, password?: string) {
    this.logger = new Logger('ProxyManager');
    this.proxies = proxyList.map(proxy => {
      const [host, port] = proxy.split(':');
      return {
        host,
        port: parseInt(port, 10),
        username,
        password,
        url: proxy
      };
    });
  }

  public getNextProxy(): ProxyConfig {
    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    return proxy;
  }

  public getCurrentProxy(): ProxyConfig {
    return this.proxies[this.currentIndex];
  }

  public createAxiosInstance(): AxiosInstance {
    const proxy = this.getNextProxy();
    const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
    
    this.logger.info(`Using proxy: ${proxy.host}:${proxy.port}`);

    return axios.create({
      httpsAgent: new HttpsProxyAgent(proxyUrl),
    });
  }

  public getProxyCount(): number {
    return this.proxies.length;
  }
} 