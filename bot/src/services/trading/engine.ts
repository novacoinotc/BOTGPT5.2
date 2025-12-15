import { EventEmitter } from 'events';
import { binanceClient } from '../binance/client.js';
import { binanceWs } from '../binance/websocket.js';
import { marketAnalyzer, MarketAnalysis } from '../market/analyzer.js';
import { cryptoPanicClient } from '../cryptopanic/client.js';
import { fearGreedIndex } from '../market/fearGreed.js';
import { gptEngine, GPTDecision } from '../gpt/engine.js';
import { memorySystem, TradeMemory } from '../memory/index.js';
import { config } from '../../config/index.js';

interface Position {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  entryConditions: any;
  gptConfidence: number;
  gptReasoning: string;
  positionSizePercent: number;
  lastGptUpdate?: number; // Timestamp of last GPT analysis for this position
}

interface BotState {
  isRunning: boolean;
  currentPositions: Map<string, Position>;
  balance: number;
  availableBalance: number;
  todayPnl: number;
  todayTrades: number;
  lastAnalysis: Map<string, MarketAnalysis>;
  lastDecision: Map<string, GPTDecision>;
}

export class TradingEngine extends EventEmitter {
  private state: BotState = {
    isRunning: false,
    currentPositions: new Map(),
    balance: 0,
    availableBalance: 0,
    todayPnl: 0,
    todayTrades: 0,
    lastAnalysis: new Map(),
    lastDecision: new Map(),
  };

  // COST OPTIMIZED: Reduced from 12 to 6 main pairs
  private symbols: string[] = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT',
    'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'
  ];
  private analysisInterval: NodeJS.Timeout | null = null;
  private positionCheckInterval: NodeJS.Timeout | null = null;
  private balanceUpdateInterval: NodeJS.Timeout | null = null;

  // Configuration - SCALPING MODE (OPTIMIZED FOR PROFITABILITY)
  private readonly MIN_CONFIDENCE = 55; // Allow trades with 55%+ confidence
  private readonly MAX_LEVERAGE = 10; // Max 10x as requested
  private readonly MAX_POSITION_SIZE_PERCENT = 5; // Max 5% of capital per trade (scalping: many small trades)
  private readonly MAX_HOLD_TIME_HOURS = 2; // Reduced to 2 hours for scalping
  private readonly MAX_TOTAL_EXPOSURE_PERCENT = 80; // Max 80% total capital in all positions
  private readonly COOLDOWN_MINUTES = 10; // Minimum time between trades on same symbol
  private readonly TRADING_FEE_PERCENT = 0.10; // Round trip fee (0.05% × 2)
  private readonly MIN_TP_PERCENT = 0.3; // Minimum take profit (lowered for scalping)
  private readonly MIN_SL_PERCENT = 0.3; // Minimum stop loss (lowered for scalping)

  // Track last trade time per symbol for cooldown
  private lastTradeTime: Map<string, number> = new Map();

  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[Engine] Already running');
      return;
    }

    console.log('[Engine] Starting trading bot...');
    console.log(`[Engine] Min confidence: ${this.MIN_CONFIDENCE}%`);
    console.log(`[Engine] Max leverage: ${this.MAX_LEVERAGE}x`);

    // Initialize
    await this.initialize();

    // Connect to WebSocket streams
    this.connectStreams();

    // Start analysis loop
    this.startAnalysisLoop();

    // Start position monitoring
    this.startPositionMonitoring();

    // Start balance updates
    this.startBalanceUpdates();

    this.state.isRunning = true;
    this.emit('started');

    console.log('[Engine] Bot started successfully');
  }

  async stop(): Promise<void> {
    console.log('[Engine] Stopping trading bot...');

    this.state.isRunning = false;

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }

    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }

    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }

    binanceWs.disconnect();

    this.emit('stopped');
    console.log('[Engine] Bot stopped');
  }

  private async initialize(): Promise<void> {
    // Get account balance
    await this.updateBalance();

    console.log(`[Engine] Account balance: $${this.state.balance.toFixed(2)}`);
    console.log(`[Engine] Available balance: $${this.state.availableBalance.toFixed(2)}`);

    // Calculate today's PnL and trades from historical data
    this.calculateTodayStats();

    // Check existing positions
    const positions = await binanceClient.getPositions();
    for (const pos of positions) {
      const entryPrice = parseFloat(pos.entryPrice);
      const quantity = Math.abs(parseFloat(pos.positionAmt));

      // Skip positions with invalid data (entryPrice=0 means no real position)
      if (!entryPrice || entryPrice <= 0 || !quantity || quantity <= 0) {
        console.log(`[Engine] Skipping invalid position ${pos.symbol}: entryPrice=${entryPrice}, qty=${quantity}`);
        continue;
      }

      const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
      this.state.currentPositions.set(pos.symbol, {
        symbol: pos.symbol,
        side,
        entryPrice,
        quantity,
        leverage: parseInt(pos.leverage) || 1,
        stopLoss: 0, // Will be updated by GPT
        takeProfit: 0,
        entryTime: Date.now(),
        entryConditions: {},
        gptConfidence: 0,
        gptReasoning: 'Existing position',
        positionSizePercent: 0,
        lastGptUpdate: Date.now(), // Initialize to now so first update happens after 5 min
      });
    }

    console.log(`[Engine] Found ${this.state.currentPositions.size} open positions`);
  }

  private async updateBalance(): Promise<void> {
    try {
      const balances = await binanceClient.getBalance();
      const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
      this.state.balance = parseFloat(usdtBalance?.balance || '0');
      this.state.availableBalance = parseFloat(usdtBalance?.availableBalance || '0');
    } catch (error) {
      console.error('[Engine] Failed to update balance:', error);
    }
  }

  private calculateTodayStats(): void {
    // Get all trades from memory (loaded from database)
    const allTrades = memorySystem.getRecentTrades(1000);

    // Filter for today's trades (GDL timezone - UTC-6)
    // Calculate midnight in GDL: UTC time + 6 hours = GDL time
    // So GDL midnight = UTC 06:00
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcDate = now.getUTCDate();
    const utcMonth = now.getUTCMonth();
    const utcYear = now.getUTCFullYear();

    // GDL is UTC-6, so GDL midnight = UTC 06:00
    // If current UTC hour is before 6, we're still in "yesterday" in GDL
    let todayStart: number;
    if (utcHours < 6) {
      // Still yesterday in GDL - use previous day's UTC 06:00
      const yesterday = new Date(Date.UTC(utcYear, utcMonth, utcDate - 1, 6, 0, 0, 0));
      todayStart = yesterday.getTime();
    } else {
      // Today in GDL - use today's UTC 06:00
      todayStart = Date.UTC(utcYear, utcMonth, utcDate, 6, 0, 0, 0);
    }

    const todayTrades = allTrades.filter(t => t.exitTime >= todayStart);

    // Calculate today's stats
    this.state.todayTrades = todayTrades.length;
    this.state.todayPnl = todayTrades.reduce((sum, t) => sum + t.pnlUsd, 0);

    const gdlTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    console.log(`[Engine] Today's stats (GDL ${gdlTime.toISOString().slice(0, 10)}): ${this.state.todayTrades} trades, $${this.state.todayPnl.toFixed(2)} PnL`);
  }

  private startBalanceUpdates(): void {
    this.balanceUpdateInterval = setInterval(async () => {
      if (!this.state.isRunning) return;
      await this.updateBalance();
    }, 60000); // Update every minute
  }

  private connectStreams(): void {
    const streams: string[] = [];

    for (const symbol of this.symbols) {
      const s = symbol.toLowerCase();
      streams.push(
        `${s}@aggTrade`,
        `${s}@kline_1m`,
        `${s}@depth10@100ms`,
        `${s}@markPrice`
      );
    }

    binanceWs.connect(streams);

    // Handle real-time data
    binanceWs.on('trade', (data) => {
      this.handleTrade(data);
    });

    binanceWs.on('kline', (data) => {
      if (data.isClosed) {
        this.handleKlineClose(data);
      }
    });

    binanceWs.on('markPrice', (data) => {
      this.handleMarkPrice(data);
    });
  }

  private handleTrade(data: any): void {
    const position = this.state.currentPositions.get(data.symbol);
    if (position) {
      this.checkPositionExit(position, data.price);
    }
  }

  private handleKlineClose(data: any): void {
    this.emit('kline', data);
  }

  private handleMarkPrice(data: any): void {
    const position = this.state.currentPositions.get(data.symbol);
    if (position) {
      const pnl = this.calculatePnl(position, data.markPrice);
      this.emit('positionUpdate', { ...position, currentPrice: data.markPrice, pnl });
    }
  }

  private startAnalysisLoop(): void {
    // COST OPTIMIZED: Analyze every 180 seconds (3 minutes) to reduce API costs
    this.analysisInterval = setInterval(async () => {
      if (!this.state.isRunning) return;

      for (const symbol of this.symbols) {
        try {
          await this.analyzeAndDecide(symbol);
        } catch (error) {
          console.error(`[Engine] Analysis error for ${symbol}:`, error);
        }
      }
    }, 180000); // 180 seconds (3 minutes)

    // Initial analysis after 5 seconds
    setTimeout(() => {
      for (const symbol of this.symbols) {
        this.analyzeAndDecide(symbol);
      }
    }, 5000);
  }

  private startPositionMonitoring(): void {
    this.positionCheckInterval = setInterval(async () => {
      if (!this.state.isRunning) return;

      // Sync positions with exchange
      const positions = await binanceClient.getPositions();
      const exchangePositions = new Set(positions.map((p: any) => p.symbol));

      // Check for closed positions
      for (const [symbol, position] of this.state.currentPositions) {
        if (!exchangePositions.has(symbol)) {
          // Position was closed externally
          this.handlePositionClosed(position);
        }
      }
    }, 10000);
  }

  // Cost optimization: Only update positions with GPT every 5 minutes
  private readonly POSITION_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  private async analyzeAndDecide(symbol: string): Promise<void> {
    const hasPosition = this.state.currentPositions.has(symbol);
    const position = this.state.currentPositions.get(symbol);

    // Get market analysis
    const analysis = await marketAnalyzer.analyze(symbol);
    this.state.lastAnalysis.set(symbol, analysis);

    // COST OPTIMIZATION: For open positions, only call GPT-5.2 every 5 minutes
    if (hasPosition && position) {
      const timeSinceLastUpdate = Date.now() - (position.lastGptUpdate || 0);
      if (timeSinceLastUpdate < this.POSITION_UPDATE_INTERVAL_MS) {
        // Skip GPT-5.2 call, just monitor SL/TP with current values
        return;
      }
      console.log(`[Engine] ${symbol}: Position update due (${Math.round(timeSinceLastUpdate / 60000)}min since last GPT analysis)`);
    }

    // STEP 1: Quick screening with cheap model (gpt-5-mini)
    // This saves ~90% of API costs by filtering out non-opportunities
    if (!hasPosition) {
      const screening = await gptEngine.quickScreen(analysis);

      if (!screening.hasOpportunity) {
        // No opportunity detected - skip expensive GPT-5.2 analysis
        console.log(`[Engine] ${symbol}: No opportunity (score: ${screening.score}) - skipping`);
        return;
      }

      console.log(`[Engine] ${symbol}: Opportunity detected! (score: ${screening.score}, direction: ${screening.direction})`);
    }

    // STEP 2: Full analysis with premium model (gpt-5.2)
    // Only called when screening detects opportunity OR position needs update (every 5 min)

    // Get news and sentiment
    const newsSummary = await cryptoPanicClient.getNewsSummary(symbol);
    const fearGreed = await fearGreedIndex.get();

    // Get recent trades (more history for better learning) and learnings
    const recentTrades = memorySystem.getRecentTrades(200); // 200 trades for full market context
    const learnings = memorySystem.getLearnings(undefined, 200); // All learnings for pattern recognition

    // Get GPT-5.2 decision with full context
    const decision = await gptEngine.analyze({
      analysis,
      news: newsSummary,
      fearGreed,
      recentTrades,
      learnings,
      accountBalance: this.state.balance,
    });

    this.state.lastDecision.set(symbol, decision);
    this.emit('analysis', { symbol, analysis, decision });

    // Log decision with dynamic precision for low-price assets
    const logPrecision = analysis.price < 1 ? 5 : analysis.price < 100 ? 4 : 2;
    console.log(`[Engine] ${symbol}: ${decision.action} (${decision.confidence}%)`);
    if (decision.action !== 'HOLD') {
      console.log(`[Engine]   └─ Size: ${decision.positionSizePercent}% | Lev: ${decision.leverage}x | SL: $${decision.stopLoss?.toFixed(logPrecision)} | TP: $${decision.takeProfit?.toFixed(logPrecision)}`);
    }

    // Execute decision
    if (!hasPosition && decision.action !== 'HOLD' && decision.confidence >= this.MIN_CONFIDENCE) {
      // Check cooldown - prevent overtrading on same symbol
      const lastTrade = this.lastTradeTime.get(symbol) || 0;
      const timeSinceLastTrade = (Date.now() - lastTrade) / 1000 / 60; // minutes
      if (timeSinceLastTrade < this.COOLDOWN_MINUTES) {
        console.log(`[Engine] ${symbol}: Cooldown active (${timeSinceLastTrade.toFixed(1)}min < ${this.COOLDOWN_MINUTES}min)`);
        return;
      }

      // Validate decision has required fields
      if (!decision.stopLoss || !decision.takeProfit) {
        console.log(`[Engine] ${symbol}: Missing SL/TP in decision, skipping`);
        return;
      }

      // Enforce minimum TP/SL to ensure profitability after fees
      const tpPercent = Math.abs((decision.takeProfit - analysis.price) / analysis.price * 100);
      const slPercent = Math.abs((decision.stopLoss - analysis.price) / analysis.price * 100);

      if (tpPercent < this.MIN_TP_PERCENT) {
        console.log(`[Engine] ${symbol}: TP too tight (${tpPercent.toFixed(2)}% < ${this.MIN_TP_PERCENT}%), skipping`);
        return;
      }

      if (slPercent < this.MIN_SL_PERCENT) {
        console.log(`[Engine] ${symbol}: SL too tight (${slPercent.toFixed(2)}% < ${this.MIN_SL_PERCENT}%), skipping`);
        return;
      }

      // Open new position
      if (config.trading.enabled) {
        await this.openPosition(symbol, decision, analysis);
        // Record trade time for cooldown
        this.lastTradeTime.set(symbol, Date.now());
      } else {
        console.log(`[Engine] ${symbol}: Paper trade - would ${decision.action}`);
        this.emit('paperTrade', { symbol, decision });
      }
    } else if (hasPosition) {
      // Update TP/SL if GPT suggests new values
      const position = this.state.currentPositions.get(symbol);
      if (position && decision.takeProfit && decision.stopLoss) {
        position.takeProfit = decision.takeProfit;
        position.stopLoss = decision.stopLoss;
        position.lastGptUpdate = Date.now(); // Track last GPT update time
        console.log(`[Engine] ${symbol}: Updated SL: $${decision.stopLoss.toFixed(2)} | TP: $${decision.takeProfit.toFixed(2)}`);
      }
    }
  }

  private async openPosition(
    symbol: string,
    decision: GPTDecision,
    analysis: MarketAnalysis
  ): Promise<void> {
    try {
      // Validate input data to prevent NaN/Infinity issues
      if (!this.isValidNumber(analysis.price) || analysis.price <= 0) {
        console.error(`[Engine] Invalid price for ${symbol}: ${analysis.price}`);
        return;
      }

      if (!this.isValidNumber(decision.leverage) || decision.leverage < 1) {
        console.error(`[Engine] Invalid leverage: ${decision.leverage}`);
        return;
      }

      if (!this.isValidNumber(decision.positionSizePercent) || decision.positionSizePercent <= 0) {
        console.error(`[Engine] Invalid position size: ${decision.positionSizePercent}%`);
        return;
      }

      // Validate leverage
      const leverage = Math.min(Math.max(1, decision.leverage), this.MAX_LEVERAGE);

      // Calculate position size based on GPT's decision
      const positionSizePercent = Math.min(decision.positionSizePercent, this.MAX_POSITION_SIZE_PERCENT);
      const capitalToUse = this.state.availableBalance * (positionSizePercent / 100);

      // Check total exposure limit before opening position
      const exposureCheck = this.canOpenNewPosition(capitalToUse);
      if (!exposureCheck.allowed) {
        console.log(`[Engine] ${symbol}: Cannot open position - ${exposureCheck.reason}`);
        return;
      }

      const positionValue = capitalToUse * leverage;
      const quantity = positionValue / analysis.price;

      // Validate calculated quantity
      if (!this.isValidNumber(quantity) || quantity <= 0) {
        console.error(`[Engine] Invalid calculated quantity: ${quantity}`);
        return;
      }

      // Get symbol info for precision
      const symbolInfo = await binanceClient.getSymbolInfo(symbol);

      // Use LOT_SIZE filter for proper quantity rounding (handles DOGEUSDT etc)
      const lotSizeFilter = symbolInfo?.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001;
      const minQty = lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.001;
      const precision = Math.max(0, Math.round(-Math.log10(stepSize)));

      // DEBUG: Log the LOT_SIZE info for troubleshooting
      if (symbol === 'DOGEUSDT' || !lotSizeFilter) {
        console.log(`[Engine] ${symbol} LOT_SIZE: stepSize=${stepSize}, minQty=${minQty}, precision=${precision}, hasFilter=${!!lotSizeFilter}`);
      }

      // Round quantity to valid step size
      let roundedQty = parseFloat(
        (Math.floor(quantity / stepSize) * stepSize).toFixed(precision)
      );

      // Ensure minimum quantity
      if (roundedQty < minQty) {
        console.log(`[Engine] ${symbol}: Quantity ${roundedQty} below minimum ${minQty}, skipping`);
        return;
      }

      // Set leverage for this trade
      await binanceClient.setLeverage(symbol, leverage);
      await binanceClient.setMarginType(symbol, 'ISOLATED');

      console.log(`[Engine] Opening ${decision.action} ${symbol}:`);
      console.log(`[Engine]   └─ Quantity: ${roundedQty} @ ~$${analysis.price.toFixed(2)}`);
      console.log(`[Engine]   └─ Leverage: ${leverage}x`);
      console.log(`[Engine]   └─ Capital used: $${capitalToUse.toFixed(2)} (${positionSizePercent}%)`);
      console.log(`[Engine]   └─ Position value: $${positionValue.toFixed(2)}`);

      // Create market order
      const order = await binanceClient.createOrder({
        symbol,
        side: decision.action === 'BUY' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: roundedQty,
      });

      // Get entry price from order fills (more reliable than avgPrice for market orders)
      let entryPrice = 0;
      if (order.fills && order.fills.length > 0) {
        // Calculate weighted average price from fills
        let totalQty = 0;
        let totalValue = 0;
        for (const fill of order.fills) {
          const fillPrice = parseFloat(fill.price);
          const fillQty = parseFloat(fill.qty);
          totalValue += fillPrice * fillQty;
          totalQty += fillQty;
        }
        entryPrice = totalQty > 0 ? totalValue / totalQty : 0;
      }

      // Fallback to avgPrice or analysis price
      if (!entryPrice || entryPrice <= 0) {
        entryPrice = parseFloat(order.avgPrice) || analysis.price;
      }

      console.log(`[Engine] Order filled: avgPrice=${order.avgPrice}, fills=${order.fills?.length || 0}, entryPrice=${entryPrice}`);

      // Calculate actual SL and TP prices
      const stopLoss = decision.stopLoss || (decision.action === 'BUY'
        ? entryPrice * (1 - (decision.stopLossPercent || 1) / 100)
        : entryPrice * (1 + (decision.stopLossPercent || 1) / 100));

      const takeProfit = decision.takeProfit || (decision.action === 'BUY'
        ? entryPrice * (1 + (decision.takeProfitPercent || 0.5) / 100)
        : entryPrice * (1 - (decision.takeProfitPercent || 0.5) / 100));

      // Store position
      const position: Position = {
        symbol,
        side: decision.action === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice,
        quantity: roundedQty,
        leverage,
        stopLoss,
        takeProfit,
        entryTime: Date.now(),
        entryConditions: {
          rsi: analysis.indicators.rsi,
          macdHistogram: analysis.indicators.macd.histogram,
          orderBookImbalance: analysis.orderBook.imbalance,
          fundingRate: analysis.funding.rate,
          regime: analysis.regime,
          fearGreed: (await fearGreedIndex.get()).value,
          newsScore: (await cryptoPanicClient.getNewsSummary(symbol)).sentiment.score,
        },
        gptConfidence: decision.confidence,
        gptReasoning: decision.reasoning,
        positionSizePercent,
        lastGptUpdate: Date.now(), // Initialize for new positions too
      };

      this.state.currentPositions.set(symbol, position);
      this.state.todayTrades++;

      // Update balance
      await this.updateBalance();

      this.emit('positionOpened', position);

      // Dynamic precision for logging (more decimals for low-price assets)
      const logPrecision = entryPrice < 1 ? 5 : entryPrice < 100 ? 4 : 2;
      console.log(`[Engine] Position opened: ${position.side} ${symbol} @ $${entryPrice.toFixed(logPrecision)}`);
      console.log(`[Engine]   └─ SL: $${stopLoss.toFixed(logPrecision)} (${((Math.abs(entryPrice - stopLoss) / entryPrice) * 100).toFixed(2)}%)`);
      console.log(`[Engine]   └─ TP: $${takeProfit.toFixed(logPrecision)} (${((Math.abs(takeProfit - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);
    } catch (error: any) {
      console.error(`[Engine] Failed to open position:`, error.message);
      this.emit('error', { type: 'openPosition', error: error.message, symbol });
    }
  }

  private async checkPositionExit(position: Position, currentPrice: number): Promise<void> {
    // Skip invalid positions (phantom positions from Binance with entryPrice=0)
    if (!position.entryPrice || position.entryPrice <= 0 || !position.quantity || position.quantity <= 0) {
      // Remove invalid position from state
      this.state.currentPositions.delete(position.symbol);
      return;
    }

    const pnl = this.calculatePnl(position, currentPrice);

    // Skip SL/TP checks if they haven't been set by GPT yet (=0)
    // GPT will set proper SL/TP on first position update (within 5 minutes)
    const hasSLTP = position.stopLoss > 0 && position.takeProfit > 0;

    if (hasSLTP) {
      // Check stop loss
      if (position.side === 'LONG' && currentPrice <= position.stopLoss) {
        await this.closePosition(position, currentPrice, 'sl');
        return;
      } else if (position.side === 'SHORT' && currentPrice >= position.stopLoss) {
        await this.closePosition(position, currentPrice, 'sl');
        return;
      }

      // Check take profit
      if (position.side === 'LONG' && currentPrice >= position.takeProfit) {
        await this.closePosition(position, currentPrice, 'tp');
        return;
      } else if (position.side === 'SHORT' && currentPrice <= position.takeProfit) {
        await this.closePosition(position, currentPrice, 'tp');
        return;
      }
    }

    // Check timeout (extended to 4 hours)
    const holdTime = Date.now() - position.entryTime;
    if (holdTime > this.MAX_HOLD_TIME_HOURS * 60 * 60 * 1000) {
      await this.closePosition(position, currentPrice, 'timeout');
      return;
    }

    // Trailing stop logic for profitable positions (optional enhancement)
    if (pnl > 1.0) { // If profit > 1%
      const newStopLoss = position.side === 'LONG'
        ? Math.max(position.stopLoss, currentPrice * 0.995) // Trail 0.5% behind
        : Math.min(position.stopLoss, currentPrice * 1.005);

      if (newStopLoss !== position.stopLoss) {
        position.stopLoss = newStopLoss;
        console.log(`[Engine] ${position.symbol}: Trailing SL updated to $${newStopLoss.toFixed(2)}`);
      }
    }
  }

  private async closePosition(
    position: Position,
    exitPrice: number,
    reason: 'tp' | 'sl' | 'manual' | 'timeout' | 'signal'
  ): Promise<void> {
    try {
      // Get symbol info for correct precision
      const symbolInfo = await binanceClient.getSymbolInfo(position.symbol);
      const lotSizeFilter = symbolInfo?.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001;
      const precision = Math.max(0, -Math.log10(stepSize));

      // Round quantity to valid step size
      const roundedQty = parseFloat(
        (Math.floor(position.quantity / stepSize) * stepSize).toFixed(precision)
      );

      // Create closing order
      // Note: positionSide omitted for one-way position mode (most common)
      // For hedge mode accounts, positionSide would need to be position.side
      await binanceClient.createOrder({
        symbol: position.symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: roundedQty,
        reduceOnly: true,
      });

      const pnlBeforeFees = this.calculatePnl(position, exitPrice);
      // Subtract trading fees from PnL (0.10% round trip)
      const pnl = pnlBeforeFees - this.TRADING_FEE_PERCENT;

      // FIX: Calculate USD P&L directly from price difference (not from leveraged %)
      // pnl already includes leverage (% return on margin), so don't multiply by leverage again
      const priceDiff = position.side === 'LONG'
        ? (exitPrice - position.entryPrice)
        : (position.entryPrice - exitPrice);
      const pnlUsdBeforeFees = priceDiff * position.quantity;

      // Subtract fees in USD: position value × 0.10%
      const positionValue = position.quantity * position.entryPrice;
      const feesUsd = positionValue * (this.TRADING_FEE_PERCENT / 100);
      const pnlUsd = pnlUsdBeforeFees - feesUsd;

      // Record trade in memory (persist to database)
      const tradeMemory = await memorySystem.addTrade({
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        quantity: position.quantity,
        pnl,
        pnlUsd,
        entryTime: position.entryTime,
        exitTime: Date.now(),
        exitReason: reason,
        entryConditions: position.entryConditions,
        gptConfidence: position.gptConfidence,
        gptReasoning: position.gptReasoning,
      });

      // Learn from trade
      const lesson = await gptEngine.learnFromTrade(tradeMemory);
      if (lesson) {
        console.log(`[Engine] 🧠 Learned: ${lesson}`);
      }

      // Update state
      this.state.currentPositions.delete(position.symbol);
      this.state.todayPnl += pnlUsd;

      // Update balance
      await this.updateBalance();

      this.emit('positionClosed', { position, exitPrice, pnl, pnlUsd, reason });

      const emoji = pnl > 0 ? '✅' : '❌';
      console.log(
        `[Engine] ${emoji} Position closed: ${position.symbol} | PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Fees: $${feesUsd.toFixed(2)} | Reason: ${reason}`
      );
    } catch (error: any) {
      console.error(`[Engine] Failed to close position:`, error.message);

      // If error is 400 (no position to close), remove from state to stop retrying
      if (error.response?.status === 400 || error.message?.includes('400')) {
        console.log(`[Engine] Removing phantom position ${position.symbol} from state (400 error)`);
        this.state.currentPositions.delete(position.symbol);
      }

      this.emit('error', { type: 'closePosition', error: error.message, symbol: position.symbol });
    }
  }

  private handlePositionClosed(position: Position): void {
    // Position was closed externally (liquidation or manual)
    this.state.currentPositions.delete(position.symbol);
    this.emit('positionClosed', { position, reason: 'external' });
    console.log(`[Engine] ⚠️ Position ${position.symbol} was closed externally`);
  }

  private calculatePnl(position: Position, currentPrice: number): number {
    // Validate inputs to prevent NaN/Infinity
    if (!this.isValidNumber(currentPrice) || !this.isValidNumber(position.entryPrice) || position.entryPrice === 0) {
      console.warn(`[Engine] Invalid PnL calculation: currentPrice=${currentPrice}, entryPrice=${position.entryPrice}`);
      return 0;
    }

    if (position.side === 'LONG') {
      return ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage;
    } else {
      return ((position.entryPrice - currentPrice) / position.entryPrice) * 100 * position.leverage;
    }
  }

  // Helper: Validate number (not NaN, not Infinity, is a number)
  private isValidNumber(value: any): boolean {
    return typeof value === 'number' && !isNaN(value) && isFinite(value);
  }

  // Helper: Calculate total exposure across all positions
  private calculateTotalExposure(): { exposureUsd: number; exposurePercent: number } {
    let totalExposure = 0;

    for (const position of this.state.currentPositions.values()) {
      // Exposure = margin used = (position value / leverage)
      const positionValue = position.quantity * position.entryPrice;
      const marginUsed = positionValue / position.leverage;
      totalExposure += marginUsed;
    }

    const exposurePercent = this.state.balance > 0
      ? (totalExposure / this.state.balance) * 100
      : 0;

    return {
      exposureUsd: totalExposure,
      exposurePercent: this.isValidNumber(exposurePercent) ? exposurePercent : 0
    };
  }

  // Helper: Check if we can open a new position given exposure limits
  private canOpenNewPosition(requiredMargin: number): { allowed: boolean; reason?: string } {
    const { exposureUsd, exposurePercent } = this.calculateTotalExposure();
    const newExposurePercent = this.state.balance > 0
      ? ((exposureUsd + requiredMargin) / this.state.balance) * 100
      : 100;

    if (newExposurePercent > this.MAX_TOTAL_EXPOSURE_PERCENT) {
      return {
        allowed: false,
        reason: `Total exposure would be ${newExposurePercent.toFixed(1)}% (max: ${this.MAX_TOTAL_EXPOSURE_PERCENT}%)`
      };
    }

    return { allowed: true };
  }

  // === PUBLIC API ===

  getState(): BotState {
    return {
      ...this.state,
      currentPositions: new Map(this.state.currentPositions),
      lastAnalysis: new Map(this.state.lastAnalysis),
      lastDecision: new Map(this.state.lastDecision),
    };
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  addSymbol(symbol: string): void {
    if (!this.symbols.includes(symbol)) {
      this.symbols.push(symbol);
      if (this.state.isRunning) {
        const s = symbol.toLowerCase();
        binanceWs.subscribe([
          `${s}@aggTrade`,
          `${s}@kline_1m`,
          `${s}@depth10@100ms`,
          `${s}@markPrice`,
        ]);
      }
      console.log(`[Engine] Added symbol: ${symbol}`);
    }
  }

  removeSymbol(symbol: string): void {
    this.symbols = this.symbols.filter(s => s !== symbol);
    if (this.state.isRunning) {
      const s = symbol.toLowerCase();
      binanceWs.unsubscribe([
        `${s}@aggTrade`,
        `${s}@kline_1m`,
        `${s}@depth10@100ms`,
        `${s}@markPrice`,
      ]);
    }
    console.log(`[Engine] Removed symbol: ${symbol}`);
  }

  async manualClose(symbol: string): Promise<void> {
    const position = this.state.currentPositions.get(symbol);
    if (position) {
      const price = await binanceClient.getPrice(symbol);
      await this.closePosition(position, price, 'manual');
    }
  }

  getConfig(): { minConfidence: number; maxLeverage: number; maxPositionSizePercent: number; maxTotalExposurePercent: number } {
    return {
      minConfidence: this.MIN_CONFIDENCE,
      maxLeverage: this.MAX_LEVERAGE,
      maxPositionSizePercent: this.MAX_POSITION_SIZE_PERCENT,
      maxTotalExposurePercent: this.MAX_TOTAL_EXPOSURE_PERCENT,
    };
  }

  // Public method to get current exposure
  getTotalExposure(): { exposureUsd: number; exposurePercent: number } {
    return this.calculateTotalExposure();
  }
}

export const tradingEngine = new TradingEngine();
