import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../../config/index.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

interface StreamData {
  stream: string;
  data: any;
}

export class BinanceWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private streams: Set<string> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private proxyAgent: HttpsProxyAgent<string> | null = null;

  constructor() {
    super();
    // Only configure proxy if all required values are present
    const hasProxy = config.proxy.host &&
                     config.proxy.port &&
                     !isNaN(config.proxy.port) &&
                     config.proxy.username &&
                     config.proxy.password;

    if (hasProxy) {
      const proxyUrl = `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`;
      this.proxyAgent = new HttpsProxyAgent(proxyUrl);
      console.log('[WS] Proxy configured');
    } else {
      console.log('[WS] No proxy configured - connecting directly');
    }
  }

  connect(streams: string[]): void {
    streams.forEach(s => this.streams.add(s));

    const streamString = Array.from(this.streams).join('/');
    const url = `${config.binance.wsUrl}/stream?streams=${streamString}`;

    // Only use proxy agent if configured
    const wsOptions = this.proxyAgent ? { agent: this.proxyAgent } : {};
    this.ws = new WebSocket(url, wsOptions);

    this.ws.on('open', () => {
      console.log('[WS] Connected to Binance');
      this.reconnectAttempts = 0;
      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const parsed: StreamData = JSON.parse(data.toString());
        this.handleMessage(parsed);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    });

    this.ws.on('close', () => {
      console.log('[WS] Connection closed');
      this.emit('disconnected');
      this.attemptReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[WS] Error:', error.message);
      this.emit('error', error);
    });
  }

  private handleMessage(data: StreamData): void {
    // FIX: Properly parse streams with multiple @ (e.g., btcusdt@depth20@100ms)
    const parts = data.stream.split('@');
    const symbol = parts[0];
    const streamType = parts.slice(1).join('@'); // Everything after first @ is the stream type

    // Handle kline streams dynamically (kline_1m, kline_5m, kline_15m, kline_1h, etc.)
    if (streamType.startsWith('kline_')) {
      const kline = data.data.k;
      this.emit('kline', {
        symbol: symbol.toUpperCase(),
        interval: kline.i,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        isClosed: kline.x,
        timestamp: kline.t,
      });
      return;
    }

    // Handle depth streams (depth5@100ms, depth10@100ms, depth20@100ms, depth@100ms)
    if (streamType.startsWith('depth')) {
      this.emit('orderbook', {
        symbol: symbol.toUpperCase(),
        bids: data.data.b.map((b: string[]) => ({
          price: parseFloat(b[0]),
          quantity: parseFloat(b[1]),
        })),
        asks: data.data.a.map((a: string[]) => ({
          price: parseFloat(a[0]),
          quantity: parseFloat(a[1]),
        })),
      });
      return;
    }

    switch (streamType) {
      case 'aggTrade':
        this.emit('trade', {
          symbol: symbol.toUpperCase(),
          price: parseFloat(data.data.p),
          quantity: parseFloat(data.data.q),
          isBuyerMaker: data.data.m,
          timestamp: data.data.T,
        });
        break;

      case 'markPrice':
        this.emit('markPrice', {
          symbol: data.data.s,
          markPrice: parseFloat(data.data.p),
          fundingRate: parseFloat(data.data.r),
          nextFundingTime: data.data.T,
        });
        break;

      default:
        this.emit('raw', data);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.emit('maxReconnectAttempts');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect(Array.from(this.streams));
    }, delay);
  }

  subscribe(streams: string[]): void {
    streams.forEach(s => this.streams.add(s));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: Date.now(),
      }));
    }
  }

  unsubscribe(streams: string[]): void {
    streams.forEach(s => this.streams.delete(s));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: streams,
        id: Date.now(),
      }));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.streams.clear();
  }
}

export const binanceWs = new BinanceWebSocket();
