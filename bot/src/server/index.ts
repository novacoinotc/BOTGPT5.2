import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createServer } from 'http';
import { config } from '../config/index.js';
import { tradingEngine } from '../services/trading/engine.js';
import { memorySystem } from '../services/memory/index.js';
import { binanceClient } from '../services/binance/client.js';
import { marketAnalyzer } from '../services/market/analyzer.js';
import { cryptoPanicClient } from '../services/cryptopanic/client.js';
import { fearGreedIndex } from '../services/market/fearGreed.js';

const app = express();
const httpServer = createServer(app);

// Socket.IO for real-time updates
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// === REST API ROUTES ===

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Bot status
app.get('/api/status', async (req, res) => {
  try {
    const state = tradingEngine.getState();

    // Get positions from both bot memory AND Binance directly
    let positions = Array.from(state.currentPositions.values());
    let balance = state.balance;

    // If bot memory is empty or balance is 0, fetch directly from Binance
    if (positions.length === 0 || balance === 0) {
      try {
        const [binancePositions, balances] = await Promise.all([
          binanceClient.getPositions(),
          binanceClient.getBalance(),
        ]);

        if (positions.length === 0) {
          positions = binancePositions.map((pos: any) => ({
            symbol: pos.symbol,
            side: (parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
            entryPrice: parseFloat(pos.entryPrice),
            quantity: Math.abs(parseFloat(pos.positionAmt)),
            leverage: parseInt(pos.leverage) || 1,
            stopLoss: 0,
            takeProfit: 0,
            entryTime: Date.now(),
            entryConditions: {},
            gptConfidence: 0,
            gptReasoning: 'Synced from Binance',
            positionSizePercent: 0,
            currentPrice: parseFloat(pos.markPrice),
            pnl: parseFloat(pos.unRealizedProfit) / (parseFloat(pos.entryPrice) * Math.abs(parseFloat(pos.positionAmt))) * 100,
          })).filter((p: any) => p.entryPrice > 0 && p.quantity > 0);
          console.log(`[API] /status - Fetched ${positions.length} positions directly from Binance`);
        }

        if (balance === 0) {
          const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
          balance = parseFloat(usdtBalance?.balance || '0');
        }
      } catch (binanceError: any) {
        console.error('[API] Failed to fetch Binance data:', binanceError.message);
      }
    }

    res.json({
      isRunning: state.isRunning,
      balance,
      todayPnl: state.todayPnl,
      todayTrades: state.todayTrades,
      openPositions: positions,
      symbols: tradingEngine.getSymbols(),
    });
  } catch (error: any) {
    console.error('[API] /status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/stats', (req, res) => {
  const stats = memorySystem.getStatistics();
  res.json(stats);
});

// Get recent trades
app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const trades = memorySystem.getRecentTrades(limit);
  res.json(trades);
});

// Get market analysis
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const analysis = await marketAnalyzer.analyze(symbol);
    const state = tradingEngine.getState();
    const lastDecision = state.lastDecision.get(symbol);

    res.json({
      analysis,
      lastDecision,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get news
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const news = await cryptoPanicClient.getNewsSummary(symbol);
    res.json(news);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get fear & greed
app.get('/api/feargreed', async (req, res) => {
  try {
    const data = await fearGreedIndex.get();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get account info
app.get('/api/account', async (req, res) => {
  try {
    const [balance, positions] = await Promise.all([
      binanceClient.getBalance(),
      binanceClient.getPositions(),
    ]);
    res.json({ balance, positions });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get learnings
app.get('/api/learnings', (req, res) => {
  const type = req.query.type as 'success' | 'failure' | undefined;
  const learnings = memorySystem.getLearnings(type);
  res.json(learnings);
});

// Start bot
app.post('/api/bot/start', async (req, res) => {
  try {
    await tradingEngine.start();
    res.json({ success: true, message: 'Bot started' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Stop bot
app.post('/api/bot/stop', async (req, res) => {
  try {
    await tradingEngine.stop();
    res.json({ success: true, message: 'Bot stopped' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Add symbol
app.post('/api/symbols', (req, res) => {
  const { symbol } = req.body;
  tradingEngine.addSymbol(symbol);
  res.json({ success: true, symbols: tradingEngine.getSymbols() });
});

// Remove symbol
app.delete('/api/symbols/:symbol', (req, res) => {
  const { symbol } = req.params;
  tradingEngine.removeSymbol(symbol);
  res.json({ success: true, symbols: tradingEngine.getSymbols() });
});

// Manual close position
app.post('/api/positions/:symbol/close', async (req, res) => {
  try {
    const { symbol } = req.params;
    await tradingEngine.manualClose(symbol);
    res.json({ success: true, message: `Position ${symbol} closed` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Export memory data
app.get('/api/memory/export', (req, res) => {
  const data = memorySystem.exportData();
  res.json(data);
});

// Import memory data
app.post('/api/memory/import', (req, res) => {
  const data = req.body;
  memorySystem.importData(data);
  res.json({ success: true });
});

// === SOCKET.IO ===

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // Send current state on connection
  const state = tradingEngine.getState();
  socket.emit('status', {
    isRunning: state.isRunning,
    balance: state.balance,
    todayPnl: state.todayPnl,
    todayTrades: state.todayTrades,
    openPositions: Array.from(state.currentPositions.values()),
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

// Forward trading engine events to Socket.IO
tradingEngine.on('started', () => {
  io.emit('botStatus', { isRunning: true });
});

tradingEngine.on('stopped', () => {
  io.emit('botStatus', { isRunning: false });
});

tradingEngine.on('analysis', (data) => {
  io.emit('analysis', data);
});

tradingEngine.on('positionOpened', (position) => {
  io.emit('positionOpened', position);
});

tradingEngine.on('positionClosed', (data) => {
  io.emit('positionClosed', data);
});

tradingEngine.on('positionUpdate', (data) => {
  io.emit('positionUpdate', data);
});

tradingEngine.on('kline', (data) => {
  io.emit('kline', data);
});

tradingEngine.on('paperTrade', (data) => {
  io.emit('paperTrade', data);
});

tradingEngine.on('error', (error) => {
  io.emit('error', error);
});

// Start server
export function startServer(): void {
  httpServer.listen(config.server.port, () => {
    console.log(`[Server] Running on port ${config.server.port}`);
  });
}

export { app, httpServer, io };
