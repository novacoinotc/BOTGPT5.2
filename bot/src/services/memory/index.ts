import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface TradeMemory {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  stopLoss?: number;
  takeProfit?: number;
  pnl: number; // percentage
  pnlUsd: number;
  entryTime: number;
  exitTime: number;
  exitReason: 'tp' | 'sl' | 'manual' | 'timeout' | 'signal';
  entryConditions: {
    rsi?: number;
    macdHistogram?: number;
    orderBookImbalance?: number;
    fundingRate?: number;
    regime?: string;
    fearGreed?: number;
    newsScore?: number;
  };
  gptConfidence: number;
  gptReasoning: string;
}

interface PatternMemory {
  symbol: string;
  pattern: string;
  regime: string;
  indicators: {
    rsi: number;
    macdHistogram: number;
    orderBookImbalance: number;
    fundingRate: number;
  };
  decision: 'BUY' | 'SELL';
  confidence: number;
  timestamp: number;
  outcome?: 'success' | 'failure';
  pnl?: number;
}

interface Learning {
  id: string;
  lesson: string;
  type: 'success' | 'failure';
  context: any;
  timestamp: number;
  useCount: number;
}

class MemorySystem {
  private trades: TradeMemory[] = [];
  private patterns: PatternMemory[] = [];
  private learnings: Learning[] = [];
  private maxTrades = 1000;
  private maxPatterns = 500;
  private maxLearnings = 100;

  // === TRADE MEMORY ===

  addTrade(trade: Omit<TradeMemory, 'id'>): TradeMemory {
    const newTrade: TradeMemory = {
      ...trade,
      id: uuidv4(),
    };

    this.trades.unshift(newTrade);

    // Keep only recent trades in memory
    if (this.trades.length > this.maxTrades) {
      this.trades = this.trades.slice(0, this.maxTrades);
    }

    // Persist to database (async, don't block)
    this.persistTradeToDb(newTrade).catch(err => {
      console.error('[Memory] Failed to persist trade to DB:', err.message);
    });

    return newTrade;
  }

  private async persistTradeToDb(trade: TradeMemory): Promise<void> {
    try {
      await prisma.trade.create({
        data: {
          id: trade.id,
          symbol: trade.symbol,
          side: trade.side,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          quantity: trade.quantity,
          leverage: Math.round(trade.leverage || 1),
          stopLoss: trade.stopLoss ?? null,
          takeProfit: trade.takeProfit ?? null,
          pnl: trade.pnl,
          pnlPercent: trade.pnl, // Same as pnl (percentage)
          pnlUsd: trade.pnlUsd,
          entryTime: new Date(trade.entryTime),
          exitTime: trade.exitTime ? new Date(trade.exitTime) : null,
          status: 'CLOSED', // Trade is closed when we persist it
          exitReason: trade.exitReason,
          gptConfidence: Math.round(trade.gptConfidence), // DB expects INTEGER
          gptReasoning: trade.gptReasoning || '',
          // Store entry conditions as JSONB
          entryConditions: trade.entryConditions || {},
          // Also store individual fields for querying
          rsi: trade.entryConditions?.rsi ?? null,
          macdHistogram: trade.entryConditions?.macdHistogram ?? null,
          orderBookImbalance: trade.entryConditions?.orderBookImbalance ?? null,
          fundingRate: trade.entryConditions?.fundingRate ?? null,
          regime: trade.entryConditions?.regime ?? null,
          fearGreedValue: trade.entryConditions?.fearGreed ? Math.round(trade.entryConditions.fearGreed) : null,
          newsScore: trade.entryConditions?.newsScore ?? null,
        },
      });
      console.log(`[Memory] ✅ Trade ${trade.symbol} persisted to DB (PnL: ${trade.pnl > 0 ? '+' : ''}${trade.pnl.toFixed(2)}%)`);
    } catch (error: any) {
      console.error(`[Memory] ❌ Failed to persist trade ${trade.symbol}:`, error.message);
      throw error;
    }
  }

  getRecentTrades(limit: number = 20): TradeMemory[] {
    return this.trades.slice(0, limit);
  }

  getTradesBySymbol(symbol: string, limit: number = 10): TradeMemory[] {
    return this.trades.filter(t => t.symbol === symbol).slice(0, limit);
  }

  getWinRate(symbol?: string): number {
    const trades = symbol
      ? this.trades.filter(t => t.symbol === symbol)
      : this.trades;

    if (trades.length === 0) return 0;

    const wins = trades.filter(t => t.pnl > 0).length;
    return (wins / trades.length) * 100;
  }

  getAveragePnl(symbol?: string): number {
    const trades = symbol
      ? this.trades.filter(t => t.symbol === symbol)
      : this.trades;

    if (trades.length === 0) return 0;

    return trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length;
  }

  getConsecutiveLosses(): number {
    let count = 0;
    for (const trade of this.trades) {
      if (trade.pnl < 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  // === PATTERN MEMORY ===

  async storePattern(pattern: PatternMemory): Promise<void> {
    this.patterns.unshift(pattern);

    if (this.patterns.length > this.maxPatterns) {
      this.patterns = this.patterns.slice(0, this.maxPatterns);
    }
  }

  findSimilarPatterns(current: Partial<PatternMemory>): PatternMemory[] {
    return this.patterns.filter(p => {
      // Match regime
      if (current.regime && p.regime !== current.regime) return false;

      // Match similar RSI (within 10 points)
      if (current.indicators?.rsi) {
        const rsiDiff = Math.abs(p.indicators.rsi - current.indicators.rsi);
        if (rsiDiff > 10) return false;
      }

      // Match similar order book imbalance (within 0.2)
      if (current.indicators?.orderBookImbalance) {
        const imbalanceDiff = Math.abs(
          p.indicators.orderBookImbalance - current.indicators.orderBookImbalance
        );
        if (imbalanceDiff > 0.2) return false;
      }

      return true;
    });
  }

  getPatternSuccessRate(patternType: string): number {
    const matchingPatterns = this.patterns.filter(
      p => p.pattern.includes(patternType) && p.outcome
    );

    if (matchingPatterns.length === 0) return 50; // Default to 50% if no data

    const successes = matchingPatterns.filter(p => p.outcome === 'success').length;
    return (successes / matchingPatterns.length) * 100;
  }

  updatePatternOutcome(timestamp: number, outcome: 'success' | 'failure', pnl: number): void {
    const pattern = this.patterns.find(p => p.timestamp === timestamp);
    if (pattern) {
      pattern.outcome = outcome;
      pattern.pnl = pnl;
    }
  }

  // === LEARNING MEMORY ===

  async storeLearning(
    lesson: string,
    type: 'success' | 'failure',
    context: any
  ): Promise<void> {
    // Check for duplicate lessons
    const existing = this.learnings.find(
      l => l.lesson.toLowerCase() === lesson.toLowerCase()
    );

    if (existing) {
      existing.useCount++;
      existing.timestamp = Date.now();
      return;
    }

    const learning: Learning = {
      id: uuidv4(),
      lesson,
      type,
      context,
      timestamp: Date.now(),
      useCount: 1,
    };

    this.learnings.unshift(learning);

    // Keep only most relevant learnings
    if (this.learnings.length > this.maxLearnings) {
      // Sort by useCount and recency, keep most useful
      this.learnings.sort((a, b) => {
        const scoreA = a.useCount * 10 + (Date.now() - a.timestamp) / 86400000;
        const scoreB = b.useCount * 10 + (Date.now() - b.timestamp) / 86400000;
        return scoreB - scoreA;
      });
      this.learnings = this.learnings.slice(0, this.maxLearnings);
    }
  }

  getLearnings(type?: 'success' | 'failure', limit: number = 10): string[] {
    let learnings = this.learnings;

    if (type) {
      learnings = learnings.filter(l => l.type === type);
    }

    return learnings.slice(0, limit).map(l => l.lesson);
  }

  getRelevantLearnings(context: { regime?: string; symbol?: string }): string[] {
    return this.learnings
      .filter(l => {
        if (context.regime && l.context.regime !== context.regime) return false;
        if (context.symbol && l.context.symbol !== context.symbol) return false;
        return true;
      })
      .slice(0, 5)
      .map(l => l.lesson);
  }

  // === STATISTICS ===

  getStatistics(): {
    totalTrades: number;
    winRate: number;
    averagePnl: number;
    totalPnlUsd: number;
    bestTrade: TradeMemory | null;
    worstTrade: TradeMemory | null;
    avgHoldTime: number;
    consecutiveLosses: number;
  } {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        averagePnl: 0,
        totalPnlUsd: 0,
        bestTrade: null,
        worstTrade: null,
        avgHoldTime: 0,
        consecutiveLosses: 0,
      };
    }

    const wins = this.trades.filter(t => t.pnl > 0);
    const totalPnlUsd = this.trades.reduce((sum, t) => sum + t.pnlUsd, 0);
    const avgHoldTime = this.trades.reduce(
      (sum, t) => sum + (t.exitTime - t.entryTime),
      0
    ) / this.trades.length;

    return {
      totalTrades: this.trades.length,
      winRate: (wins.length / this.trades.length) * 100,
      averagePnl: this.getAveragePnl(),
      totalPnlUsd,
      bestTrade: this.trades.reduce((best, t) =>
        !best || t.pnl > best.pnl ? t : best, null as TradeMemory | null),
      worstTrade: this.trades.reduce((worst, t) =>
        !worst || t.pnl < worst.pnl ? t : worst, null as TradeMemory | null),
      avgHoldTime: avgHoldTime / 60000, // in minutes
      consecutiveLosses: this.getConsecutiveLosses(),
    };
  }

  // === PERSISTENCE ===

  exportData(): {
    trades: TradeMemory[];
    patterns: PatternMemory[];
    learnings: Learning[];
  } {
    return {
      trades: this.trades,
      patterns: this.patterns,
      learnings: this.learnings,
    };
  }

  importData(data: {
    trades?: TradeMemory[];
    patterns?: PatternMemory[];
    learnings?: Learning[];
  }): void {
    if (data.trades) this.trades = data.trades;
    if (data.patterns) this.patterns = data.patterns;
    if (data.learnings) this.learnings = data.learnings;
  }

  clear(): void {
    this.trades = [];
    this.patterns = [];
    this.learnings = [];
  }
}

export const memorySystem = new MemorySystem();
