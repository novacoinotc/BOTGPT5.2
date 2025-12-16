import { EventEmitter } from 'events';
import { binanceClient } from '../binance/client.js';
import { binanceWs } from '../binance/websocket.js';
import { marketAnalyzer, MarketAnalysis } from '../market/analyzer.js';
import { cryptoPanicClient } from '../cryptopanic/client.js';
import { fearGreedIndex } from '../market/fearGreed.js';
import { gptEngine, GPTDecision } from '../gpt/engine.js';
import { memorySystem, TradeMemory } from '../memory/index.js';
import { config } from '../../config/index.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
}

interface BotState {
  isRunning: boolean;
  currentPositions: Map<string, Position>;
  balance: number;
  availableBalance: number;
  todayPnl: number;
  todayTrades: number;
  lastResetDate: string; // YYYY-MM-DD format for daily reset
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
    lastResetDate: new Date().toISOString().split('T')[0], // Initialize to today
    lastAnalysis: new Map(),
    lastDecision: new Map(),
  };
  private dailyResetInterval: NodeJS.Timeout | null = null;

  private symbols: string[] = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
    'XRPUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOGEUSDT',
    'SUIUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT'
  ];
  private analysisInterval: NodeJS.Timeout | null = null;
  private positionCheckInterval: NodeJS.Timeout | null = null;
  private balanceUpdateInterval: NodeJS.Timeout | null = null;

  // Configuration - SCALPING MODE
  private readonly MIN_CONFIDENCE = 45; // Lowered from 65 to allow more learning
  private readonly MAX_LEVERAGE = 10; // Max 10x as requested
  private readonly MAX_POSITION_SIZE_PERCENT = 5; // Max 5% of capital per trade (scalping: many small trades)
  private readonly MAX_HOLD_TIME_HOURS = 2; // Reduced to 2 hours for scalping
  private readonly MAX_TOTAL_EXPOSURE_PERCENT = 80; // Max 80% total capital in all positions

  // Quantity precision by symbol (Binance Futures) - verified from exchange info
  private readonly QUANTITY_PRECISION: Record<string, number> = {
    'BTCUSDT': 3,
    'ETHUSDT': 3,
    'BNBUSDT': 2,
    'SOLUSDT': 0,
    'XRPUSDT': 0,
    'LINKUSDT': 2,
    'AVAXUSDT': 0,
    'DOGEUSDT': 0,
    'SUIUSDT': 0,
    'ARBUSDT': 0,
    'OPUSDT': 0,
    'INJUSDT': 1,
    'ADAUSDT': 0,
    'MATICUSDT': 0,
    'DOTUSDT': 1,
    'LTCUSDT': 3,
    'ATOMUSDT': 2,
    'NEARUSDT': 0,
    'APTUSDT': 1,
    'FILUSDT': 1,
    'WLDUSDT': 0,
    'SEIUSDT': 0,
    'TIAUSDT': 1,
    'CRVUSDT': 0,
    'TONUSDT': 1,
  };

  // Price precision by symbol (Binance Futures)
  private readonly PRICE_PRECISION: Record<string, number> = {
    'BTCUSDT': 1,
    'ETHUSDT': 2,
    'BNBUSDT': 2,
    'SOLUSDT': 2,
    'XRPUSDT': 4,
    'LINKUSDT': 3,
    'AVAXUSDT': 2,
    'DOGEUSDT': 5,
    'SUIUSDT': 4,
    'ARBUSDT': 4,
    'OPUSDT': 4,
    'INJUSDT': 3,
    'ADAUSDT': 4,
    'MATICUSDT': 4,
    'DOTUSDT': 3,
    'LTCUSDT': 2,
    'ATOMUSDT': 3,
    'NEARUSDT': 3,
    'APTUSDT': 3,
    'FILUSDT': 3,
    'WLDUSDT': 3,
    'SEIUSDT': 4,
    'TIAUSDT': 3,
    'CRVUSDT': 4,
    'TONUSDT': 3,
  };

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

    // Start daily reset checker
    this.checkAndResetDaily(); // Check immediately on start
    this.startDailyReset();

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

    if (this.dailyResetInterval) {
      clearInterval(this.dailyResetInterval);
      this.dailyResetInterval = null;
    }

    binanceWs.disconnect();

    this.emit('stopped');
    console.log('[Engine] Bot stopped');
  }

  private async initialize(): Promise<void> {
    // Load bot state from database (todayPnl, todayTrades, lastResetDate)
    await this.loadStateFromDb();

    // Get account balance
    await this.updateBalance();

    console.log(`[Engine] Account balance: $${this.state.balance.toFixed(2)}`);
    console.log(`[Engine] Available balance: $${this.state.availableBalance.toFixed(2)}`);

    // Check existing positions
    const positions = await binanceClient.getPositions();
    console.log(`[Engine] Raw positions from Binance:`, positions.length > 0 ? JSON.stringify(positions, null, 2) : 'NONE');

    for (const pos of positions) {
      const entryPrice = parseFloat(pos.entryPrice);
      const quantity = Math.abs(parseFloat(pos.positionAmt));

      // Skip positions with invalid data (entryPrice=0 means no real position)
      if (!entryPrice || entryPrice <= 0 || !quantity || quantity <= 0) {
        console.log(`[Engine] Skipping invalid position ${pos.symbol}: entryPrice=${entryPrice}, qty=${quantity}`);
        continue;
      }

      console.log(`[Engine] ✓ Loading position: ${pos.symbol} ${parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT'} @ $${entryPrice}`);

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

  // === DATABASE PERSISTENCE FOR BOT STATE ===

  private async loadStateFromDb(): Promise<void> {
    try {
      // Get or create bot state in database
      const botState = await prisma.botState.upsert({
        where: { id: 'main' },
        create: {
          id: 'main',
          isRunning: true,
          balance: 0,
          todayPnl: 0,
          todayTrades: 0,
          lastResetDate: new Date(),
          symbols: this.symbols,
        },
        update: {},
      });

      // Check if we need to reset (new day)
      const today = new Date().toISOString().split('T')[0];
      const lastResetDay = botState.lastResetDate.toISOString().split('T')[0];

      if (lastResetDay === today) {
        // Same day - restore values
        this.state.todayPnl = botState.todayPnl;
        this.state.todayTrades = botState.todayTrades;
        this.state.lastResetDate = today;
        console.log(`[Engine] 📊 Restored from DB: todayPnl=$${this.state.todayPnl.toFixed(2)}, todayTrades=${this.state.todayTrades}`);
      } else {
        // New day - reset but keep the last reset date updated
        this.state.todayPnl = 0;
        this.state.todayTrades = 0;
        this.state.lastResetDate = today;
        console.log(`[Engine] 📊 New day detected - reset todayPnl/todayTrades`);
        await this.saveStateToDb();
      }
    } catch (error: any) {
      console.error('[Engine] Failed to load state from DB:', error.message);
      // Continue with default values
    }
  }

  private async saveStateToDb(): Promise<void> {
    try {
      await prisma.botState.upsert({
        where: { id: 'main' },
        create: {
          id: 'main',
          isRunning: this.state.isRunning,
          balance: this.state.balance,
          todayPnl: this.state.todayPnl,
          todayTrades: this.state.todayTrades,
          lastResetDate: new Date(this.state.lastResetDate),
          symbols: this.symbols,
        },
        update: {
          isRunning: this.state.isRunning,
          balance: this.state.balance,
          todayPnl: this.state.todayPnl,
          todayTrades: this.state.todayTrades,
          lastResetDate: new Date(this.state.lastResetDate),
          symbols: this.symbols,
        },
      });
    } catch (error: any) {
      console.error('[Engine] Failed to save state to DB:', error.message);
    }
  }

  private startBalanceUpdates(): void {
    this.balanceUpdateInterval = setInterval(async () => {
      if (!this.state.isRunning) return;
      await this.updateBalance();
      // Persist bot state to DB every balance update cycle
      await this.saveStateToDb();
    }, 10000); // Update every 10 seconds for faster sync
  }

  private startDailyReset(): void {
    // Check for daily reset every minute
    this.dailyResetInterval = setInterval(() => {
      this.checkAndResetDaily();
    }, 60000); // Check every minute
  }

  private async checkAndResetDaily(): Promise<void> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (this.state.lastResetDate !== today) {
      console.log(`[Engine] 🔄 Daily reset: ${this.state.lastResetDate} → ${today}`);
      console.log(`[Engine]   └─ Yesterday's PnL: $${this.state.todayPnl.toFixed(2)}`);
      console.log(`[Engine]   └─ Yesterday's trades: ${this.state.todayTrades}`);

      // Reset daily metrics
      this.state.todayPnl = 0;
      this.state.todayTrades = 0;
      this.state.lastResetDate = today;

      // Persist reset to database
      await this.saveStateToDb();

      console.log(`[Engine] ✅ Daily metrics reset for ${today}`);
      this.emit('dailyReset', { date: today });
    }
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
    // Analyze every 3 minutes (180 seconds) - optimized for scalping
    this.analysisInterval = setInterval(async () => {
      if (!this.state.isRunning) return;

      for (const symbol of this.symbols) {
        try {
          await this.analyzeAndDecide(symbol);
        } catch (error) {
          console.error(`[Engine] Analysis error for ${symbol}:`, error);
        }
      }
    }, 180000);

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

  private async analyzeAndDecide(symbol: string): Promise<void> {
    const hasPosition = this.state.currentPositions.has(symbol);

    // Get market analysis
    const analysis = await marketAnalyzer.analyze(symbol);
    this.state.lastAnalysis.set(symbol, analysis);

    // STEP 1: Quick screening with cheap model (gpt-4o-mini)
    // This saves ~90% of API costs by filtering out non-opportunities
    let screeningResult: { hasOpportunity: boolean; direction: 'BUY' | 'SELL' | 'NONE'; score: number } | undefined;

    if (!hasPosition) {
      screeningResult = await gptEngine.quickScreen(analysis);

      if (!screeningResult.hasOpportunity) {
        // No opportunity detected - skip expensive GPT-5.2 analysis
        console.log(`[Engine] ${symbol}: No opportunity (score: ${screeningResult.score}) - skipping full analysis`);
        return;
      }

      console.log(`[Engine] ${symbol}: Opportunity detected! (score: ${screeningResult.score}, direction: ${screeningResult.direction})`);
    }

    // STEP 2: Full analysis with premium model (gpt-5.2)
    // Only called when screening detects opportunity OR we have an open position to manage

    // Get news and sentiment
    const newsSummary = await cryptoPanicClient.getNewsSummary(symbol);
    const fearGreed = await fearGreedIndex.get();

    // Get recent trades and learnings - INCREASED to 200 for better learning
    const recentTrades = memorySystem.getTradesBySymbol(symbol, 200);
    const learnings = memorySystem.getRelevantLearnings({
      regime: analysis.regime,
      symbol,
    }, 200); // Get up to 200 learnings

    // Get Q-Learning recommendation from 87.95% win rate IA
    const totalTradeCount = memorySystem.getStatistics().totalTrades || 0;
    const qLearningRecommendation = await gptEngine.getQLearningRecommendation(
      analysis,
      fearGreed.value,
      totalTradeCount
    );
    console.log(`[Engine] ${symbol}: Q-Learning recommends ${qLearningRecommendation.action} (${qLearningRecommendation.confidence.toFixed(1)}% conf)`);

    // Get optimized parameters from 236-trial optimizer with REAL win rate
    const stats = memorySystem.getStatistics();
    const realWinRate = stats.winRate || 50; // Use real win rate, default to 50%
    const optimizerParams = gptEngine.getOptimizerRecommendation(
      analysis,
      fearGreed.value,
      screeningResult,
      realWinRate
    );
    console.log(`[Engine] ${symbol}: Optimizer suggests leverage=${optimizerParams.leverage}x, TP=${optimizerParams.tpPct.toFixed(2)}%, SL=${optimizerParams.slPct.toFixed(2)}% (WR: ${realWinRate.toFixed(1)}%)`);

    // Get GPT-5.2 decision with full context - NOW INCLUDING Q-LEARNING AND OPTIMIZER
    const decision = await gptEngine.analyze({
      analysis,
      news: newsSummary,
      fearGreed,
      recentTrades,
      learnings,
      accountBalance: this.state.balance,
      screeningResult, // Pass screening result so GPT-5.2 knows what the quick screen detected
      qLearningRecommendation, // Pass Q-Learning recommendation from 87.95% WR IA
      optimizerParams, // Pass optimized parameters from 236 trials
    });

    this.state.lastDecision.set(symbol, decision);
    this.emit('analysis', { symbol, analysis, decision });

    // Log decision with more detail
    console.log(`[Engine] ${symbol}: ${decision.action} (${decision.confidence}%)`);

    // Warning: Log when GPT-5.2 contradicts the screening
    if (screeningResult && screeningResult.hasOpportunity && screeningResult.direction !== 'NONE') {
      if (decision.action === 'HOLD') {
        console.log(`[Engine] ⚠️ ${symbol}: GPT-5.2 said HOLD but screening detected ${screeningResult.direction} (score: ${screeningResult.score})`);
        console.log(`[Engine]   └─ Reason for rejection: ${decision.reasoning.slice(0, 150)}...`);
      } else if (decision.action !== screeningResult.direction) {
        console.log(`[Engine] ⚠️ ${symbol}: Direction mismatch! Screening: ${screeningResult.direction}, GPT-5.2: ${decision.action}`);
      }
    }
    console.log(`[Engine]   └─ ${decision.reasoning.slice(0, 100)}...`);
    if (decision.action !== 'HOLD') {
      console.log(`[Engine]   └─ Size: ${decision.positionSizePercent}% | Leverage: ${decision.leverage}x`);
      console.log(`[Engine]   └─ SL: $${decision.stopLoss?.toFixed(2)} | TP: $${decision.takeProfit?.toFixed(2)}`);
    }

    // Execute decision
    if (!hasPosition && decision.action !== 'HOLD' && decision.confidence >= this.MIN_CONFIDENCE) {
      // Check risk management
      const consecutiveLosses = memorySystem.getConsecutiveLosses();

      if (consecutiveLosses >= 5) {
        console.log(`[Engine] ${symbol}: Skipping trade - ${consecutiveLosses} consecutive losses (cooling down)`);
        return;
      }

      // Reduce size after consecutive losses
      let adjustedSizePercent = decision.positionSizePercent;
      if (consecutiveLosses >= 3) {
        adjustedSizePercent = Math.max(5, decision.positionSizePercent * 0.5);
        console.log(`[Engine] ${symbol}: Reduced position size to ${adjustedSizePercent}% due to ${consecutiveLosses} consecutive losses`);
      }

      // Validate decision has required fields
      if (!decision.stopLoss || !decision.takeProfit) {
        console.log(`[Engine] ${symbol}: Missing SL/TP in decision, skipping`);
        return;
      }

      // Open new position
      if (config.trading.enabled) {
        await this.openPosition(symbol, { ...decision, positionSizePercent: adjustedSizePercent }, analysis);
      } else {
        console.log(`[Engine] ${symbol}: Paper trade - would ${decision.action}`);
        this.emit('paperTrade', { symbol, decision });
      }
    } else if (hasPosition) {
      // Update TP/SL if GPT suggests new values
      const position = this.state.currentPositions.get(symbol);
      if (position && decision.takeProfit && decision.stopLoss) {
        // Validate SL/TP are correct for position direction
        const isValidForLong = position.side === 'LONG' &&
          decision.stopLoss < position.entryPrice &&
          decision.takeProfit > position.entryPrice;
        const isValidForShort = position.side === 'SHORT' &&
          decision.stopLoss > position.entryPrice &&
          decision.takeProfit < position.entryPrice;

        if (isValidForLong || isValidForShort) {
          position.takeProfit = decision.takeProfit;
          position.stopLoss = decision.stopLoss;
          console.log(`[Engine] ${symbol}: Updated SL: $${decision.stopLoss.toFixed(2)} | TP: $${decision.takeProfit.toFixed(2)}`);
        } else {
          console.log(`[Engine] ${symbol}: Rejected invalid SL/TP update (${position.side} @ $${position.entryPrice.toFixed(2)}, SL: $${decision.stopLoss.toFixed(2)}, TP: $${decision.takeProfit.toFixed(2)})`);
        }
      }
    }
  }

  private async openPosition(
    symbol: string,
    decision: GPTDecision,
    analysis: MarketAnalysis
  ): Promise<void> {
    // Prevent race conditions - don't try to open a position that's already being opened
    if (this.openingPositions.has(symbol)) {
      console.log(`[Engine] ${symbol}: Already opening position, skipping duplicate`);
      return;
    }
    this.openingPositions.add(symbol);

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

      // Get symbol info for precision - use our known map first, then API, then default
      const quantityPrecision = this.QUANTITY_PRECISION[symbol] ?? 3;

      // Round to precision and ensure it's not too small
      const roundedQty = parseFloat(quantity.toFixed(quantityPrecision));

      console.log(`[Engine] Quantity calculation: raw=${quantity}, precision=${quantityPrecision}, rounded=${roundedQty}`);

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

      // FIX: Binance returns avgPrice="0" for unfilled market orders
      // Use fills array if available, otherwise fallback to analysis.price
      let entryPrice = 0;

      if (order.avgPrice && parseFloat(order.avgPrice) > 0) {
        entryPrice = parseFloat(order.avgPrice);
      } else if (order.fills && order.fills.length > 0) {
        // Calculate weighted average from fills
        const totalQty = order.fills.reduce((sum: number, f: any) => sum + parseFloat(f.qty), 0);
        const totalValue = order.fills.reduce((sum: number, f: any) => sum + parseFloat(f.price) * parseFloat(f.qty), 0);
        // FIX: Prevent Infinity when totalQty is 0
        if (totalQty > 0) {
          entryPrice = totalValue / totalQty;
        } else {
          // Fallback to current market price if fills have no quantity
          entryPrice = analysis.price;
        }
      } else {
        // Fallback to current market price
        entryPrice = analysis.price;
      }

      // Validate entry price
      if (!entryPrice || entryPrice <= 0) {
        console.error(`[Engine] ❌ Invalid entry price: ${entryPrice}, order response:`, JSON.stringify(order));
        throw new Error(`Invalid entry price for ${symbol}`);
      }

      console.log(`[Engine] Order filled: avgPrice=${order.avgPrice}, fills=${order.fills?.length || 0}, entryPrice=${entryPrice.toFixed(4)}`);

      // Calculate actual SL and TP prices with proper precision
      const pricePrecision = this.PRICE_PRECISION[symbol] ?? 4;

      const rawStopLoss = decision.stopLoss || (decision.action === 'BUY'
        ? entryPrice * (1 - (decision.stopLossPercent || 1) / 100)
        : entryPrice * (1 + (decision.stopLossPercent || 1) / 100));

      const rawTakeProfit = decision.takeProfit || (decision.action === 'BUY'
        ? entryPrice * (1 + (decision.takeProfitPercent || 0.5) / 100)
        : entryPrice * (1 - (decision.takeProfitPercent || 0.5) / 100));

      // Round to price precision
      const stopLoss = parseFloat(rawStopLoss.toFixed(pricePrecision));
      const takeProfit = parseFloat(rawTakeProfit.toFixed(pricePrecision));

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
      };

      this.state.currentPositions.set(symbol, position);
      this.state.todayTrades++;

      // Update balance and persist state to DB
      await this.updateBalance();
      await this.saveStateToDb();

      this.emit('positionOpened', position);

      console.log(`[Engine] Position opened: ${position.side} ${symbol} @ $${entryPrice.toFixed(2)}`);
      console.log(`[Engine]   └─ SL: $${stopLoss.toFixed(2)} (${((Math.abs(entryPrice - stopLoss) / entryPrice) * 100).toFixed(2)}%)`);
      console.log(`[Engine]   └─ TP: $${takeProfit.toFixed(2)} (${((Math.abs(takeProfit - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);
    } catch (error: any) {
      console.error(`[Engine] ❌ Failed to open position ${symbol}:`, error.message);
      // Log full Binance error details
      if (error.response?.data) {
        console.error(`[Engine] Binance error details:`, JSON.stringify(error.response.data));
      }
      this.emit('error', { type: 'openPosition', error: error.message, symbol });
    } finally {
      // Always remove from opening set, regardless of success/failure
      this.openingPositions.delete(symbol);
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

  private closingPositions = new Set<string>(); // Track positions being closed to prevent race conditions
  private openingPositions = new Set<string>(); // Track positions being opened to prevent race conditions

  private async closePosition(
    position: Position,
    exitPrice: number,
    reason: 'tp' | 'sl' | 'manual' | 'timeout' | 'signal'
  ): Promise<void> {
    // Prevent race conditions - don't try to close a position that's already being closed
    if (this.closingPositions.has(position.symbol)) {
      console.log(`[Engine] ${position.symbol}: Already closing, skipping duplicate close`);
      return;
    }
    this.closingPositions.add(position.symbol);

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

      const pnl = this.calculatePnl(position, exitPrice);
      // FIX: Calculate USD P&L with commission deduction
      // Binance Futures taker fee: ~0.04% total (0.02% entry + 0.02% exit)
      const priceDiff = position.side === 'LONG'
        ? (exitPrice - position.entryPrice)
        : (position.entryPrice - exitPrice);
      const grossPnlUsd = priceDiff * position.quantity;
      // Calculate commission based on both entry AND exit values
      const entryValue = position.entryPrice * position.quantity;
      const exitValue = exitPrice * position.quantity;
      const entryCommission = entryValue * 0.0002; // 0.02% entry
      const exitCommission = exitValue * 0.0002;   // 0.02% exit
      const commissionFee = entryCommission + exitCommission;
      const pnlUsd = grossPnlUsd - commissionFee;

      // Record trade in memory AND database
      const tradeMemory = memorySystem.addTrade({
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        quantity: position.quantity,
        leverage: position.leverage,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
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

      // Update balance and persist state to DB
      await this.updateBalance();
      await this.saveStateToDb();

      this.emit('positionClosed', { position, exitPrice, pnl, pnlUsd, reason });

      const emoji = pnl > 0 ? '✅' : '❌';
      console.log(
        `[Engine] ${emoji} Position closed: ${position.symbol} | PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Reason: ${reason}`
      );
    } catch (error: any) {
      console.error(`[Engine] Failed to close position:`, error.message);
      this.emit('error', { type: 'closePosition', error: error.message, symbol: position.symbol });
    } finally {
      // Always remove from closing set, regardless of success/failure
      this.closingPositions.delete(position.symbol);
    }
  }

  private async handlePositionClosed(position: Position): Promise<void> {
    // Position was closed externally (liquidation or manual)
    // We need to record this trade for learning and statistics

    // Skip if we're currently closing this position (prevents race condition)
    if (this.closingPositions.has(position.symbol)) {
      console.log(`[Engine] ${position.symbol}: Detected external close but already closing locally`);
      return;
    }

    try {
      // Get current price to estimate exit
      const currentPrice = await binanceClient.getPrice(position.symbol);

      const pnl = this.calculatePnl(position, currentPrice);
      const priceDiff = position.side === 'LONG'
        ? (currentPrice - position.entryPrice)
        : (position.entryPrice - currentPrice);
      const grossPnlUsd = priceDiff * position.quantity;
      // FIX: Add commission deduction for external closes too
      const entryValue = position.entryPrice * position.quantity;
      const exitValue = currentPrice * position.quantity;
      const commissionFee = (entryValue + exitValue) * 0.0002; // 0.02% each side
      const pnlUsd = grossPnlUsd - commissionFee;

      // Record trade in memory AND database
      const tradeMemory = memorySystem.addTrade({
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        quantity: position.quantity,
        leverage: position.leverage,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        pnl,
        pnlUsd,
        entryTime: position.entryTime,
        exitTime: Date.now(),
        exitReason: 'manual', // External close (liquidation or manual from exchange)
        entryConditions: position.entryConditions,
        gptConfidence: position.gptConfidence,
        gptReasoning: position.gptReasoning,
      });

      // Learn from trade (important for liquidations!)
      const lesson = await gptEngine.learnFromTrade(tradeMemory);
      if (lesson) {
        console.log(`[Engine] 🧠 Learned from external close: ${lesson}`);
      }

      // Update daily PnL and persist to DB
      this.state.todayPnl += pnlUsd;
      await this.saveStateToDb();

      const emoji = pnl > 0 ? '✅' : '❌';
      console.log(`[Engine] ${emoji} Position closed externally: ${position.symbol} | PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
    } catch (error: any) {
      console.error(`[Engine] Failed to record externally closed position:`, error.message);
    }

    this.state.currentPositions.delete(position.symbol);
    this.emit('positionClosed', { position, reason: 'external' });
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
