import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const config = {
  // Binance
  binance: {
    apiKey: process.env.BINANCE_API_KEY!,
    secretKey: process.env.BINANCE_SECRET_KEY!,
    baseUrl: 'https://fapi.binance.com',
    wsUrl: 'wss://fstream.binance.com',
  },

  // Proxy
  proxy: {
    host: process.env.PROXY_HOST!,
    port: parseInt(process.env.PROXY_PORT!),
    username: process.env.PROXY_USERNAME!,
    password: process.env.PROXY_PASSWORD!,
  },

  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-5.2', // Latest model
  },

  // CryptoPanic
  cryptoPanic: {
    apiKey: process.env.CRYPTOPANIC_API_KEY!,
    baseUrl: 'https://cryptopanic.com/api/v1',
  },

  // Database
  database: {
    url: process.env.DATABASE_URL!,
  },

  // Trading
  trading: {
    enabled: process.env.TRADING_ENABLED === 'true',
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '100'),
    maxLeverage: parseInt(process.env.MAX_LEVERAGE || '20'),
    riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '0.02'),
    scalpingTargetProfit: parseFloat(process.env.SCALPING_TARGET_PROFIT || '0.003'),
    scalpingStopLoss: parseFloat(process.env.SCALPING_STOP_LOSS || '0.005'),
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || '3001'),
  },
};

export type Config = typeof config;
