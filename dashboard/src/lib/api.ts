const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }

  return response.json();
}

export const api = {
  // Bot status
  getStatus: () => fetchApi<BotStatus>('/api/status'),

  // Statistics
  getStats: () => fetchApi<Statistics>('/api/stats'),

  // Trades
  getTrades: (limit = 50) => fetchApi<Trade[]>(`/api/trades?limit=${limit}`),

  // Analysis
  getAnalysis: (symbol: string) => fetchApi<Analysis>(`/api/analysis/${symbol}`),

  // News
  getNews: (symbol: string) => fetchApi<NewsSummary>(`/api/news/${symbol}`),

  // Fear & Greed
  getFearGreed: () => fetchApi<FearGreed>('/api/feargreed'),

  // Account
  getAccount: () => fetchApi<Account>('/api/account'),

  // Learnings
  getLearnings: (type?: string) =>
    fetchApi<string[]>(`/api/learnings${type ? `?type=${type}` : ''}`),

  // Bot control
  startBot: () =>
    fetchApi<{ success: boolean }>('/api/bot/start', { method: 'POST' }),

  stopBot: () =>
    fetchApi<{ success: boolean }>('/api/bot/stop', { method: 'POST' }),

  // Symbols
  addSymbol: (symbol: string) =>
    fetchApi<{ success: boolean; symbols: string[] }>('/api/symbols', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    }),

  removeSymbol: (symbol: string) =>
    fetchApi<{ success: boolean; symbols: string[] }>(`/api/symbols/${symbol}`, {
      method: 'DELETE',
    }),

  // Position
  closePosition: (symbol: string) =>
    fetchApi<{ success: boolean }>(`/api/positions/${symbol}/close`, {
      method: 'POST',
    }),
};

// Types
export interface BotStatus {
  isRunning: boolean;
  balance: number;
  todayPnl: number;
  todayTrades: number;
  openPositions: Position[];
  symbols: string[];
}

export interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  gptConfidence: number;
  gptReasoning: string;
  currentPrice?: number;
  pnl?: number;
}

export interface Statistics {
  totalTrades: number;
  winRate: number;
  averagePnl: number;
  totalPnlUsd: number;
  bestTrade: Trade | null;
  worstTrade: Trade | null;
  avgHoldTime: number;
  consecutiveLosses: number;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlUsd: number;
  entryTime: number;
  exitTime: number;
  exitReason: string;
  gptConfidence: number;
  gptReasoning: string;
}

export interface Analysis {
  analysis: {
    symbol: string;
    price: number;
    change24h: number;
    volume24h: number;
    indicators: {
      rsi: number;
      macd: { macd: number; signal: number; histogram: number };
      ema9: number;
      ema21: number;
      sma50: number;
      bollingerBands: { upper: number; middle: number; lower: number };
      atr: number;
      adx: number;
    };
    orderBook: {
      bidPressure: number;
      askPressure: number;
      imbalance: number;
      spreadPercent: number;
    };
    funding: { rate: number; sentiment: string };
    regime: string;
    volumeProfile: { poc: number; valueAreaHigh: number; valueAreaLow: number };
  };
  lastDecision: {
    action: string;
    confidence: number;
    reasoning: string;
    entryPrice?: number;
    stopLoss?: number;
    takeProfit?: number;
    patterns: string[];
  } | null;
}

export interface NewsSummary {
  headlines: string[];
  sentiment: { score: number; bullish: number; bearish: number };
  hotTopics: string[];
}

export interface FearGreed {
  value: number;
  classification: string;
  timestamp: number;
}

export interface Account {
  balance: { asset: string; balance: string; availableBalance: string }[];
  positions: any[];
}
