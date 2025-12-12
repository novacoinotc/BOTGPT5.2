import { startServer } from './server/index.js';
import { tradingEngine } from './services/trading/engine.js';
import { config } from './config/index.js';

console.log('=========================================');
console.log('    GPT 5.2 SCALPING BOT - v1.0.0');
console.log('=========================================');
console.log('');

async function main(): Promise<void> {
  try {
    // Validate configuration
    validateConfig();

    // Start HTTP server
    startServer();

    // Auto-start bot if enabled
    if (config.trading.enabled) {
      console.log('[Main] Auto-starting trading bot...');
      await tradingEngine.start();
    } else {
      console.log('[Main] Trading disabled. Use API to start bot.');
      console.log('[Main] POST /api/bot/start to begin');
    }

    // Handle shutdown gracefully
    setupGracefulShutdown();

    console.log('');
    console.log('[Main] Bot is ready!');
    console.log(`[Main] Dashboard API: http://localhost:${config.server.port}`);
    console.log(`[Main] WebSocket: ws://localhost:${config.server.port}`);
    console.log('');

  } catch (error) {
    console.error('[Main] Fatal error:', error);
    process.exit(1);
  }
}

function validateConfig(): void {
  const required = [
    ['BINANCE_API_KEY', config.binance.apiKey],
    ['BINANCE_SECRET_KEY', config.binance.secretKey],
    ['OPENAI_API_KEY', config.openai.apiKey],
    ['CRYPTOPANIC_API_KEY', config.cryptoPanic.apiKey],
  ];

  for (const [name, value] of required) {
    if (!value || value === 'undefined') {
      throw new Error(`Missing required config: ${name}`);
    }
  }

  console.log('[Config] All required configurations present');
  console.log(`[Config] Trading enabled: ${config.trading.enabled}`);
  console.log(`[Config] Max leverage: ${config.trading.maxLeverage}x`);
  console.log(`[Config] Risk per trade: ${config.trading.riskPerTrade * 100}%`);
  console.log(`[Config] Target profit: ${config.trading.scalpingTargetProfit * 100}%`);
  console.log(`[Config] Stop loss: ${config.trading.scalpingStopLoss * 100}%`);
}

function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[Main] Received ${signal}. Shutting down...`);

    try {
      await tradingEngine.stop();
      console.log('[Main] Bot stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error('[Main] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
