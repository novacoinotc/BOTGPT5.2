import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../../config/index.js';

export class BinanceClient {
  private client: AxiosInstance;
  private proxyAgent: HttpsProxyAgent<string>;

  constructor() {
    const proxyUrl = `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`;
    this.proxyAgent = new HttpsProxyAgent(proxyUrl);

    this.client = axios.create({
      baseURL: config.binance.baseUrl,
      httpsAgent: this.proxyAgent,
      headers: {
        'X-MBX-APIKEY': config.binance.apiKey,
      },
    });
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

  private addSignature(params: Record<string, any>): Record<string, any> {
    const timestamp = Date.now();
    const paramsWithTimestamp = { ...params, timestamp };
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
    const params = this.addSignature({});
    const response = await this.client.get('/fapi/v3/account', { params }); // V3 for better performance
    return response.data;
  }

  async getBalance(): Promise<any[]> {
    const params = this.addSignature({});
    const response = await this.client.get('/fapi/v3/balance', { params }); // V3 for better performance
    return response.data;
  }

  async getPositions(): Promise<any[]> {
    const params = this.addSignature({});
    const response = await this.client.get('/fapi/v3/positionRisk', { params }); // V3 returns only active positions
    return response.data.filter((p: any) => parseFloat(p.positionAmt) !== 0);
  }

  // === TRADING ===

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    const params = this.addSignature({ symbol, leverage });
    const response = await this.client.post('/fapi/v1/leverage', null, { params });
    return response.data;
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<any> {
    try {
      const params = this.addSignature({ symbol, marginType });
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

    const signedParams = this.addSignature(orderParams);
    const response = await this.client.post('/fapi/v1/order', null, { params: signedParams });
    return response.data;
  }

  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    const params = this.addSignature({ symbol, orderId });
    const response = await this.client.delete('/fapi/v1/order', { params });
    return response.data;
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    const params = this.addSignature({ symbol });
    const response = await this.client.delete('/fapi/v1/allOpenOrders', { params });
    return response.data;
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params = this.addSignature(symbol ? { symbol } : {});
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
