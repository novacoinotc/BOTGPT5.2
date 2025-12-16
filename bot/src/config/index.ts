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
    model: 'gpt-4o', // Latest GPT-4o model
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

  // Trading - GPT decides most parameters dynamically
  trading: {
    enabled: process.env.TRADING_ENABLED === 'true',
    maxPositionSizePercent: parseInt(process.env.MAX_POSITION_SIZE_PERCENT || '50'), // Max 50% of capital
    maxLeverage: parseInt(process.env.MAX_LEVERAGE || '10'), // Max 10x leverage
    minConfidence: parseInt(process.env.MIN_CONFIDENCE || '45'), // Lowered for learning
    maxHoldTimeHours: parseInt(process.env.MAX_HOLD_TIME_HOURS || '4'), // Extended hold time
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || '3001'),
  },
};

export type Config = typeof config;
