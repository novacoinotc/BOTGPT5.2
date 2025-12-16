import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../../config/index.js';

// Simple rate limiter to prevent API bans
class RateLimiter {
  private requestTimestamps: number[] = [];
  private orderTimestamps: number[] = [];
  private readonly MAX_REQUESTS_PER_MIN = 1200;
  private readonly MAX_ORDERS_PER_10S = 300;

  async waitForSlot(isOrder: boolean = false): Promise<void> {
    const now = Date.now();

    // Clean old timestamps
    this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60000);
    this.orderTimestamps = this.orderTimestamps.filter(t => now - t < 10000);

    // Check request limit (90% threshold)
    if (this.requestTimestamps.length >= this.MAX_REQUESTS_PER_MIN * 0.9) {
      const waitTime = 60000 - (now - this.requestTimestamps[0]) + 100;
      console.warn(`[RateLimit] Approaching request limit, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Check order limit (90% threshold)
    if (isOrder && this.orderTimestamps.length >= this.MAX_ORDERS_PER_10S * 0.9) {
      const waitTime = 10000 - (now - this.orderTimestamps[0]) + 100;
      console.warn(`[RateLimit] Approaching order limit, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.requestTimestamps.push(Date.now());
    if (isOrder) {
      this.orderTimestamps.push(Date.now());
    }
  }
}

export class BinanceClient {
  private client: AxiosInstance;
  private rateLimiter = new RateLimiter();
  private timeOffset = 0; // Difference between local time and server time
  private lastTimeSync = 0;
  private readonly TIME_SYNC_INTERVAL = 300000; // Sync every 5 minutes
  private initialized = false;

  constructor() {
    const axiosConfig: any = {
      baseURL: config.binance.baseUrl,
      headers: {
        'X-MBX-APIKEY': config.binance.apiKey,
      },
    };

    // Only use proxy if all proxy settings are configured
    const hasProxy = config.proxy.host &&
                     config.proxy.port &&
                     !isNaN(config.proxy.port) &&
                     config.proxy.username &&
                     config.proxy.password;

    if (hasProxy) {
      const proxyUrl = `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`;
      const proxyAgent = new HttpsProxyAgent(proxyUrl);
      axiosConfig.httpsAgent = proxyAgent;
      console.log('[Binance] Using proxy:', config.proxy.host);
    } else {
      console.log('[Binance] No proxy configured, connecting directly');
    }

    this.client = axios.create(axiosConfig);
  }

  // Initialize client - MUST be called before first signed request
  async init(): Promise<void> {
    if (this.initialized) return;
    console.log('[Binance] Initializing client...');
    await this.syncTime();
    this.initialized = true;
    console.log('[Binance] Client initialized');
  }

  private sign(params: Record<string, any>): string {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return crypto
      .createHmac('sha256', config.binance.secretKey)
      .update(queryString)
      .digest('hex');
  }

  // Sync time with Binance server to prevent -1021 timestamp errors
  async syncTime(): Promise<void> {
    try {
      const localBefore = Date.now();
      const response = await this.client.get('/fapi/v1/time');
      const localAfter = Date.now();

      const serverTime = response.data.serverTime;
      const localTime = Math.floor((localBefore + localAfter) / 2); // Average to account for latency

      this.timeOffset = serverTime - localTime;
      this.lastTimeSync = Date.now();

      if (Math.abs(this.timeOffset) > 1000) {
        console.log(`[Binance] Time synced: offset=${this.timeOffset}ms (local clock is ${this.timeOffset > 0 ? 'behind' : 'ahead'})`);
      }
    } catch (error: any) {
      console.error('[Binance] Failed to sync time:', error.message);
    }
  }

  private async addSignature(params: Record<string, any>): Promise<Record<string, any>> {
    // Ensure client is initialized (first time sync)
    if (!this.initialized) {
      await this.init();
    }

    // Re-sync time if needed (every 5 minutes)
    if (Date.now() - this.lastTimeSync > this.TIME_SYNC_INTERVAL) {
      await this.syncTime();
    }

    // Use corrected timestamp
    const timestamp = Date.now() + this.timeOffset;
    const paramsWithTimestamp = { ...params, timestamp, recvWindow: 10000 }; // 10s window for safety
    const signature = this.sign(paramsWithTimestamp);
    return { ...paramsWithTimestamp, signature };
  }

  // === MARKET DATA ===

  async getPrice(symbol: string): Promise<number> {
    const response = await this.client.get('/fapi/v1/ticker/price', {
      params: { symbol },
    });
    return parseFloat(response.data.price);
  }

  async getKlines(symbol: string, interval: string, limit: number = 100): Promise<any[]> {
    const response = await this.client.get('/fapi/v1/klines', {
      params: { symbol, interval, limit },
    });
    return response.data;
  }

  async getOrderBook(symbol: string, limit: number = 20): Promise<{
    bids: [string, string][];
    asks: [string, string][];
  }> {
    const response = await this.client.get('/fapi/v1/depth', {
      params: { symbol, limit },
    });
    return response.data;
  }

  async get24hrTicker(symbol: string): Promise<any> {
    const response = await this.client.get('/fapi/v1/ticker/24hr', {
      params: { symbol },
    });
    return response.data;
  }

  async getFundingRate(symbol: string): Promise<any> {
    const response = await this.client.get('/fapi/v1/fundingRate', {
      params: { symbol, limit: 1 },
    });
    return response.data[0];
  }

  async getOpenInterest(symbol: string): Promise<any> {
    const response = await this.client.get('/fapi/v1/openInterest', {
      params: { symbol },
    });
    return response.data;
  }

  async getLongShortRatio(symbol: string, period: string = '5m'): Promise<any> {
    const response = await this.client.get('/futures/data/globalLongShortAccountRatio', {
      params: { symbol, period, limit: 1 },
    });
    return response.data[0];
  }

  // === ACCOUNT ===

  async getAccountInfo(): Promise<any> {
    await this.rateLimiter.waitForSlot();
    const params = await this.addSignature({});
    const response = await this.client.get('/fapi/v3/account', { params }); // V3 for better performance
    return response.data;
  }

  async getBalance(): Promise<any[]> {
    await this.rateLimiter.waitForSlot();
    const params = await this.addSignature({});
    const response = await this.client.get('/fapi/v3/balance', { params }); // V3 for better performance
    return response.data;
  }

  async getPositions(): Promise<any[]> {
    try {
      await this.rateLimiter.waitForSlot();
      const params = await this.addSignature({});
      const response = await this.client.get('/fapi/v3/positionRisk', { params });

      const allPositions = response.data || [];
      const activePositions = allPositions.filter((p: any) => {
        const amt = parseFloat(p.positionAmt || '0');
        return amt !== 0;
      });

      console.log(`[Binance] Fetched ${allPositions.length} position records, ${activePositions.length} active`);
      return activePositions;
    } catch (error: any) {
      console.error('[Binance] ❌ Failed to fetch positions:', error.message);
      if (error.response?.data) {
        console.error('[Binance] Error details:', JSON.stringify(error.response.data));
      }
      return []; // Return empty array instead of throwing
    }
  }

  // === TRADING ===

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    await this.rateLimiter.waitForSlot();
    const params = await this.addSignature({ symbol, leverage });
    const response = await this.client.post('/fapi/v1/leverage', null, { params });
    return response.data;
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<any> {
    try {
      await this.rateLimiter.waitForSlot();
      const params = await this.addSignature({ symbol, marginType });
      const response = await this.client.post('/fapi/v1/marginType', null, { params });
      return response.data;
    } catch (error: any) {
      // Ignore if margin type is already set
      if (error.response?.data?.code === -4046) {
        return { msg: 'Margin type already set' };
      }
      throw error;
    }
  }

  async createOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: number;
    price?: number;
    stopPrice?: number;
    reduceOnly?: boolean;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }): Promise<any> {
    const orderParams: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      positionSide: params.positionSide || 'BOTH',
    };

    if (params.quantity) {
      orderParams.quantity = params.quantity;
    }

    if (params.price && params.type === 'LIMIT') {
      orderParams.price = params.price;
      orderParams.timeInForce = 'GTC';
    }

    if (params.stopPrice) {
      orderParams.stopPrice = params.stopPrice;
    }

    if (params.reduceOnly) {
      orderParams.reduceOnly = 'true';
    }

    // Rate limit check for orders (stricter limit)
    await this.rateLimiter.waitForSlot(true);
    const signedParams = await this.addSignature(orderParams);
    const response = await this.client.post('/fapi/v1/order', null, { params: signedParams });
    return response.data;
  }

  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    await this.rateLimiter.waitForSlot(true);
    const params = await this.addSignature({ symbol, orderId });
    const response = await this.client.delete('/fapi/v1/order', { params });
    return response.data;
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    await this.rateLimiter.waitForSlot(true);
    const params = await this.addSignature({ symbol });
    const response = await this.client.delete('/fapi/v1/allOpenOrders', { params });
    return response.data;
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    await this.rateLimiter.waitForSlot();
    const params = await this.addSignature(symbol ? { symbol } : {});
    const response = await this.client.get('/fapi/v1/openOrders', { params });
    return response.data;
  }

  // === EXCHANGE INFO ===

  async getExchangeInfo(): Promise<any> {
    const response = await this.client.get('/fapi/v1/exchangeInfo');
    return response.data;
  }

  async getSymbolInfo(symbol: string): Promise<any> {
    const exchangeInfo = await this.getExchangeInfo();
    return exchangeInfo.symbols.find((s: any) => s.symbol === symbol);
  }
}

export const binanceClient = new BinanceClient();
