import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../database/index.js';

export interface TradeMemory {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number; // percentage
  pnlUsd: number;
  entryTime: number;
  exitTime: number;
  exitReason: 'tp' | 'sl' | 'manual' | 'timeout' | 'signal';
  entryConditions: {
    rsi: number;
    macdHistogram: number;
    orderBookImbalance: number;
    fundingRate: number;
    regime: string;
    fearGreed: number;
    newsScore: number;
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
  private maxTrades = 10000; // Store up to 10k trades in memory (all persist in DB)
  private maxPatterns = 5000;
  private maxLearnings = 1000;
  private initialized = false;

  // === INITIALIZATION (Load from DB) ===

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('[Memory] Loading historical data from database...');

      // Load trades from database
      const dbTrades = await prisma.trade.findMany({
        orderBy: { entryTime: 'desc' },
        take: this.maxTrades,
      });

      this.trades = dbTrades.map((t: any) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side as 'LONG' | 'SHORT',
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice || 0,
        quantity: t.quantity,
        pnl: t.pnl || 0,
        pnlUsd: t.pnlUsd || 0,
        entryTime: t.entryTime.getTime(),
        exitTime: t.exitTime?.getTime() || 0,
        exitReason: (t.exitReason || 'manual') as TradeMemory['exitReason'],
        entryConditions: {
          rsi: t.rsi || 50,
          macdHistogram: t.macdHistogram || 0,
          orderBookImbalance: t.orderBookImbalance || 0,
          fundingRate: t.fundingRate || 0,
          regime: t.regime || 'unknown',
          fearGreed: t.fearGreedValue || 50,
          newsScore: t.newsScore || 0,
        },
        gptConfidence: t.gptConfidence,
        gptReasoning: t.gptReasoning,
      }));

      console.log(`[Memory] Loaded ${this.trades.length} trades from database`);

      // Load learnings from database
      const dbLearnings = await prisma.learning.findMany({
        orderBy: { useCount: 'desc' },
        take: this.maxLearnings,
      });

      this.learnings = dbLearnings.map((l: any) => ({
        id: l.id,
        lesson: l.lesson,
        type: l.type as 'success' | 'failure',
        context: l.context as any,
        timestamp: l.timestamp.getTime(),
        useCount: l.useCount,
      }));

      console.log(`[Memory] Loaded ${this.learnings.length} learnings from database`);

      // Load patterns from database
      const dbPatterns = await prisma.pattern.findMany({
        orderBy: { timestamp: 'desc' },
        take: this.maxPatterns,
      });

      this.patterns = dbPatterns.map((p: any) => ({
        symbol: p.symbol,
        pattern: p.patternType,
        regime: p.regime,
        indicators: {
          rsi: p.rsi,
          macdHistogram: p.macdHistogram,
          orderBookImbalance: p.orderBookImbalance,
          fundingRate: p.fundingRate,
        },
        decision: p.decision as 'BUY' | 'SELL',
        confidence: p.confidence,
        timestamp: p.timestamp.getTime(),
        outcome: p.outcome as 'success' | 'failure' | undefined,
        pnl: p.resultPnl || undefined,
      }));

      console.log(`[Memory] Loaded ${this.patterns.length} patterns from database`);

      this.initialized = true;
      console.log('[Memory] Database initialization complete!');

    } catch (error) {
      console.error('[Memory] Error loading from database:', error);
      // Continue with empty memory if DB fails
      this.initialized = true;
    }
  }

  // === TRADE MEMORY ===

  async addTrade(trade: Omit<TradeMemory, 'id'>): Promise<TradeMemory> {
    const newTrade: TradeMemory = {
      ...trade,
      id: uuidv4(),
    };

    this.trades.unshift(newTrade);

    // Keep only recent trades in memory
    if (this.trades.length > this.maxTrades) {
      this.trades = this.trades.slice(0, this.maxTrades);
    }

    // Persist to database
    try {
      await prisma.trade.create({
        data: {
          id: newTrade.id,
          symbol: newTrade.symbol,
          side: newTrade.side,
          entryPrice: newTrade.entryPrice,
          exitPrice: newTrade.exitPrice,
          quantity: newTrade.quantity,
          leverage: 1, // Will be updated if available
          pnl: newTrade.pnl,
          pnlUsd: newTrade.pnlUsd,
          entryTime: new Date(newTrade.entryTime),
          exitTime: new Date(newTrade.exitTime),
          exitReason: newTrade.exitReason,
          gptConfidence: newTrade.gptConfidence,
          gptReasoning: newTrade.gptReasoning,
          rsi: newTrade.entryConditions.rsi,
          macdHistogram: newTrade.entryConditions.macdHistogram,
          orderBookImbalance: newTrade.entryConditions.orderBookImbalance,
          fundingRate: newTrade.entryConditions.fundingRate,
          regime: newTrade.entryConditions.regime,
          fearGreedValue: newTrade.entryConditions.fearGreed,
          newsScore: newTrade.entryConditions.newsScore,
        },
      });
      console.log(`[Memory] Trade ${newTrade.id} persisted to database`);
    } catch (error) {
      console.error('[Memory] Error persisting trade:', error);
    }

    return newTrade;
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

    // Persist to database
    try {
      await prisma.pattern.create({
        data: {
          symbol: pattern.symbol,
          patternType: pattern.pattern,
          regime: pattern.regime,
          rsi: pattern.indicators.rsi,
          macdHistogram: pattern.indicators.macdHistogram,
          orderBookImbalance: pattern.indicators.orderBookImbalance,
          fundingRate: pattern.indicators.fundingRate,
          decision: pattern.decision,
          confidence: pattern.confidence,
          timestamp: new Date(pattern.timestamp),
        },
      });
    } catch (error) {
      console.error('[Memory] Error persisting pattern:', error);
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

  async updatePatternOutcome(timestamp: number, outcome: 'success' | 'failure', pnl: number): Promise<void> {
    const pattern = this.patterns.find(p => p.timestamp === timestamp);
    if (pattern) {
      pattern.outcome = outcome;
      pattern.pnl = pnl;

      // Update in database
      try {
        await prisma.pattern.updateMany({
          where: { timestamp: new Date(timestamp) },
          data: { outcome, resultPnl: pnl },
        });
      } catch (error) {
        console.error('[Memory] Error updating pattern outcome:', error);
      }
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

      // Update in database
      try {
        await prisma.learning.update({
          where: { id: existing.id },
          data: {
            useCount: existing.useCount,
            timestamp: new Date(existing.timestamp),
          },
        });
      } catch (error) {
        console.error('[Memory] Error updating learning:', error);
      }
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

    // Persist to database
    try {
      await prisma.learning.create({
        data: {
          id: learning.id,
          lesson: learning.lesson,
          type: learning.type,
          context: learning.context,
          useCount: learning.useCount,
          timestamp: new Date(learning.timestamp),
        },
      });
      console.log(`[Memory] Learning persisted to database: "${lesson.substring(0, 50)}..."`);
    } catch (error) {
      console.error('[Memory] Error persisting learning:', error);
    }

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

  // === PERSISTENCE (Legacy methods kept for compatibility) ===

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

  // Clear ALL data from memory AND database - for fresh start
  async clearAllData(): Promise<void> {
    console.log('[Memory] 🗑️ Clearing ALL data from memory and database...');

    try {
      // Clear database tables
      await prisma.trade.deleteMany({});
      await prisma.pattern.deleteMany({});
      await prisma.learning.deleteMany({});
      await prisma.dailyStats.deleteMany({});

      // Reset bot state
      await prisma.botState.updateMany({
        data: {
          todayPnl: 0,
          todayTrades: 0,
          lastResetDate: new Date(),
        }
      });

      // Clear memory
      this.trades = [];
      this.patterns = [];
      this.learnings = [];

      console.log('[Memory] ✅ All data cleared successfully - fresh start!');
    } catch (error) {
      console.error('[Memory] Error clearing data:', error);
      throw error;
    }
  }
}

export const memorySystem = new MemorySystem();
