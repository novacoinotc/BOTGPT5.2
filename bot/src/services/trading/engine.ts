import { EventEmitter } from 'events';
import { binanceClient } from '../binance/client.js';
import { binanceWs } from '../binance/websocket.js';
import { marketAnalyzer, MarketAnalysis } from '../market/analyzer.js';
import { cryptoPanicClient } from '../cryptopanic/client.js';
import { fearGreedIndex } from '../market/fearGreed.js';
import { gptEngine } from '../gpt/engine.js';
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
}

interface BotState {
  isRunning: boolean;
  currentPositions: Map<string, Position>;
  balance: number;
  todayPnl: number;
  todayTrades: number;
  lastAnalysis: Map<string, MarketAnalysis>;
  lastDecision: Map<string, any>;
}

export class TradingEngine extends EventEmitter {
  private state: BotState = {
    isRunning: false,
    currentPositions: new Map(),
    balance: 0,
    todayPnl: 0,
    todayTrades: 0,
    lastAnalysis: new Map(),
    lastDecision: new Map(),
  };

  private symbols: string[] = ['BTCUSDT', 'ETHUSDT'];
  private analysisInterval: NodeJS.Timeout | null = null;
  private positionCheckInterval: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    if (this.state.isRunning) {
      console.log('[Engine] Already running');
      return;
    }

    console.log('[Engine] Starting trading bot...');

    // Initialize
    await this.initialize();

    // Connect to WebSocket streams
    this.connectStreams();

    // Start analysis loop
    this.startAnalysisLoop();

    // Start position monitoring
    this.startPositionMonitoring();

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

    binanceWs.disconnect();

    this.emit('stopped');
    console.log('[Engine] Bot stopped');
  }

  private async initialize(): Promise<void> {
    // Get account balance
    const balances = await binanceClient.getBalance();
    const usdtBalance = balances.find((b: any) => b.asset === 'USDT');
    this.state.balance = parseFloat(usdtBalance?.balance || '0');

    console.log(`[Engine] Account balance: $${this.state.balance.toFixed(2)}`);

    // Set leverage for all symbols
    for (const symbol of this.symbols) {
      try {
        await binanceClient.setLeverage(symbol, config.trading.maxLeverage);
        await binanceClient.setMarginType(symbol, 'ISOLATED');
        console.log(`[Engine] ${symbol}: Leverage ${config.trading.maxLeverage}x, Isolated margin`);
      } catch (error: any) {
        console.log(`[Engine] ${symbol}: ${error.message}`);
      }
    }

    // Check existing positions
    const positions = await binanceClient.getPositions();
    for (const pos of positions) {
      const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
      this.state.currentPositions.set(pos.symbol, {
        symbol: pos.symbol,
        side,
        entryPrice: parseFloat(pos.entryPrice),
        quantity: Math.abs(parseFloat(pos.positionAmt)),
        leverage: parseInt(pos.leverage),
        stopLoss: 0, // Will be set by GPT
        takeProfit: 0,
        entryTime: Date.now(),
        entryConditions: {},
        gptConfidence: 0,
        gptReasoning: 'Existing position',
      });
    }

    console.log(`[Engine] Found ${this.state.currentPositions.size} open positions`);
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
    // Analyze every 30 seconds
    this.analysisInterval = setInterval(async () => {
      if (!this.state.isRunning) return;

      for (const symbol of this.symbols) {
        try {
          await this.analyzeAndDecide(symbol);
        } catch (error) {
          console.error(`[Engine] Analysis error for ${symbol}:`, error);
        }
      }
    }, 30000);

    // Initial analysis
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
          // Position was closed
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

    // Get news and sentiment
    const newsSummary = await cryptoPanicClient.getNewsSummary(symbol);
    const fearGreed = await fearGreedIndex.get();

    // Get recent trades and learnings
    const recentTrades = memorySystem.getTradesBySymbol(symbol, 20);
    const learnings = memorySystem.getRelevantLearnings({
      regime: analysis.regime,
      symbol,
    });

    // Get GPT decision
    const decision = await gptEngine.analyze({
      analysis,
      news: newsSummary,
      fearGreed,
      recentTrades,
      learnings,
    });

    this.state.lastDecision.set(symbol, decision);
    this.emit('analysis', { symbol, analysis, decision });

    console.log(`[Engine] ${symbol}: ${decision.action} (${decision.confidence}%) - ${decision.reasoning}`);

    // Execute decision
    if (!hasPosition && decision.action !== 'HOLD' && decision.confidence >= 65) {
      // Check risk management
      const consecutiveLosses = memorySystem.getConsecutiveLosses();
      if (consecutiveLosses >= 3) {
        console.log(`[Engine] ${symbol}: Skipping trade - ${consecutiveLosses} consecutive losses`);
        return;
      }

      // Open new position
      if (config.trading.enabled) {
        await this.openPosition(symbol, decision, analysis);
      } else {
        console.log(`[Engine] ${symbol}: Paper trade - would ${decision.action}`);
        this.emit('paperTrade', { symbol, decision });
      }
    } else if (hasPosition && decision.action === 'HOLD') {
      // Update TP/SL if GPT suggests
      if (decision.takeProfit && decision.stopLoss) {
        const position = this.state.currentPositions.get(symbol)!;
        position.takeProfit = decision.takeProfit;
        position.stopLoss = decision.stopLoss;
      }
    }
  }

  private async openPosition(
    symbol: string,
    decision: any,
    analysis: MarketAnalysis
  ): Promise<void> {
    try {
      // Calculate position size
      const riskAmount = this.state.balance * config.trading.riskPerTrade;
      const slDistance = Math.abs(analysis.price - decision.stopLoss!) / analysis.price;
      const positionValue = riskAmount / slDistance;
      const quantity = positionValue / analysis.price;

      // Get symbol info for precision
      const symbolInfo = await binanceClient.getSymbolInfo(symbol);
      const quantityPrecision = symbolInfo?.quantityPrecision || 3;
      const pricePrecision = symbolInfo?.pricePrecision || 2;

      const roundedQty = parseFloat(quantity.toFixed(quantityPrecision));

      console.log(`[Engine] Opening ${decision.action} ${symbol}: ${roundedQty} @ ~$${analysis.price}`);

      // Create market order
      const order = await binanceClient.createOrder({
        symbol,
        side: decision.action === 'BUY' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: roundedQty,
      });

      const entryPrice = parseFloat(order.avgPrice || analysis.price.toString());

      // Store position
      const position: Position = {
        symbol,
        side: decision.action === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice,
        quantity: roundedQty,
        leverage: config.trading.maxLeverage,
        stopLoss: decision.stopLoss!,
        takeProfit: decision.takeProfit!,
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
      };

      this.state.currentPositions.set(symbol, position);
      this.state.todayTrades++;

      this.emit('positionOpened', position);

      console.log(`[Engine] Position opened: ${position.side} ${symbol} @ $${entryPrice}`);
      console.log(`[Engine] SL: $${decision.stopLoss} | TP: $${decision.takeProfit}`);
    } catch (error: any) {
      console.error(`[Engine] Failed to open position:`, error.message);
      this.emit('error', { type: 'openPosition', error: error.message });
    }
  }

  private async checkPositionExit(position: Position, currentPrice: number): Promise<void> {
    const pnl = this.calculatePnl(position, currentPrice);

    // Check stop loss
    if (position.side === 'LONG' && currentPrice <= position.stopLoss) {
      await this.closePosition(position, currentPrice, 'sl');
    } else if (position.side === 'SHORT' && currentPrice >= position.stopLoss) {
      await this.closePosition(position, currentPrice, 'sl');
    }

    // Check take profit
    if (position.side === 'LONG' && currentPrice >= position.takeProfit) {
      await this.closePosition(position, currentPrice, 'tp');
    } else if (position.side === 'SHORT' && currentPrice <= position.takeProfit) {
      await this.closePosition(position, currentPrice, 'tp');
    }

    // Check timeout (max 2 hours for scalping)
    const holdTime = Date.now() - position.entryTime;
    if (holdTime > 2 * 60 * 60 * 1000) {
      await this.closePosition(position, currentPrice, 'timeout');
    }
  }

  private async closePosition(
    position: Position,
    exitPrice: number,
    reason: 'tp' | 'sl' | 'manual' | 'timeout' | 'signal'
  ): Promise<void> {
    try {
      // Create closing order
      await binanceClient.createOrder({
        symbol: position.symbol,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: position.quantity,
        reduceOnly: true,
      });

      const pnl = this.calculatePnl(position, exitPrice);
      const pnlUsd = (pnl / 100) * position.entryPrice * position.quantity * position.leverage;

      // Record trade in memory
      const tradeMemory = memorySystem.addTrade({
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
        console.log(`[Engine] Learned: ${lesson}`);
      }

      // Update state
      this.state.currentPositions.delete(position.symbol);
      this.state.todayPnl += pnlUsd;

      this.emit('positionClosed', { position, exitPrice, pnl, pnlUsd, reason });

      console.log(
        `[Engine] Position closed: ${position.symbol} | PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | Reason: ${reason}`
      );
    } catch (error: any) {
      console.error(`[Engine] Failed to close position:`, error.message);
      this.emit('error', { type: 'closePosition', error: error.message });
    }
  }

  private handlePositionClosed(position: Position): void {
    // Position was closed externally (liquidation or manual)
    this.state.currentPositions.delete(position.symbol);
    this.emit('positionClosed', { position, reason: 'external' });
  }

  private calculatePnl(position: Position, currentPrice: number): number {
    if (position.side === 'LONG') {
      return ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * position.leverage;
    } else {
      return ((position.entryPrice - currentPrice) / position.entryPrice) * 100 * position.leverage;
    }
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
  }

  async manualClose(symbol: string): Promise<void> {
    const position = this.state.currentPositions.get(symbol);
    if (position) {
      const price = await binanceClient.getPrice(symbol);
      await this.closePosition(position, price, 'manual');
    }
  }
}

export const tradingEngine = new TradingEngine();
