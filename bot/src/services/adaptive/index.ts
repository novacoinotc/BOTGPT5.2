/**
 * Adaptive Learning System - Main module
 * Combines Q-Learning, Parameter Optimization, and State Encoding
 * Based on the 87.95% win rate IA architecture
 */

import { PrismaClient } from '@prisma/client';
import { stateEncoder, MarketState, ActionType } from './stateEncoder';
import { qLearningAgent, QLearningAgent } from './qLearningAgent';
import { parameterOptimizer, ParameterOptimizer } from './parameterOptimizer';

const prisma = new PrismaClient();

export interface TradeDecision {
  shouldTrade: boolean;
  action: ActionType;
  confidence: number;
  leverage: number;
  positionSizePct: number;
  tpPct: number;
  slPct: number;
  stateKey: string;
  reasoning: string;
  isExploration: boolean;
  qValues: Record<ActionType, number>;
}

export interface TradeResult {
  stateKey: string;
  action: ActionType;
  pnlPct: number;
  exitReason: string;
  leverage: number;
  duration: number; // minutes
}

export class AdaptiveLearningSystem {
  private qAgent: QLearningAgent;
  private paramOptimizer: ParameterOptimizer;
  private isInitialized: boolean = false;
  private totalTrades: number = 0;

  constructor() {
    this.qAgent = qLearningAgent;
    this.paramOptimizer = parameterOptimizer;
  }

  /**
   * Initialize the system with pre-trained values
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[AdaptiveLearning] Initializing system...');

    try {
      // Load parameters
      await this.paramOptimizer.loadParams();
      await this.paramOptimizer.initializeParams();

      // Initialize Q-table with pre-trained values
      await this.qAgent.initializePretrainedValues();

      // Get total trades count
      const tradeCount = await prisma.trade.count();
      this.totalTrades = tradeCount;

      this.isInitialized = true;
      console.log('[AdaptiveLearning] System initialized successfully');
      console.log(`[AdaptiveLearning] Total historical trades: ${this.totalTrades}`);
    } catch (error) {
      console.error('[AdaptiveLearning] Initialization error:', error);
      this.isInitialized = true; // Continue anyway with defaults
    }
  }

  /**
   * Get optimal trading decision for current market state
   */
  async getDecision(marketState: MarketState, gptConfidence: number): Promise<TradeDecision> {
    await this.initialize();

    // Update trade count
    marketState.tradeCount = this.totalTrades;

    // Get Q-Learning recommendation
    const qResult = await this.qAgent.selectAction(marketState, true);

    // Get parameter-based recommendation
    const paramRec = this.paramOptimizer.getRecommendation({
      confidence: gptConfidence,
      regime: marketState.regime,
      regimeStrength: marketState.regimeStrength,
      volatility: marketState.volatility,
      fearGreed: marketState.fearGreedIndex,
      rsi: marketState.rsi,
      signal: marketState.signal
    });

    // Combine decisions
    const params = this.paramOptimizer.getParams();
    const actionParams = stateEncoder.actionToParams(qResult.action, {
      basePositionPct: params.basePositionPct,
      conservativeLev: params.conservativeLev,
      balancedLev: params.balancedLev,
      aggressiveLev: params.aggressiveLev
    });

    // Check if Q-Learning has meaningful data for this state
    const maxQValue = Math.max(...Object.values(qResult.qValues));
    const qLearningHasData = maxQValue > 0.5; // Threshold for "meaningful" Q-value

    // Build final decision:
    // - If Q-Learning has data AND says trade → trade
    // - If Q-Learning has NO data → let GPT/params decide (shouldTrade based on params)
    // - If Q-Learning has data AND says SKIP → follow Q-Learning (skip)
    let shouldTrade: boolean;
    if (qLearningHasData) {
      // Q-Learning has experience - follow its recommendation
      shouldTrade = qResult.action !== 'SKIP' && paramRec.shouldTrade;
    } else {
      // Q-Learning has no data - let params/GPT decide
      shouldTrade = paramRec.shouldTrade;
    }

    // Use Q-Learning action if it recommends trading, otherwise follow params
    const finalLeverage = shouldTrade
      ? Math.max(actionParams.leverage, paramRec.leverage)
      : 1;

    const finalPositionSize = shouldTrade
      ? Math.max(actionParams.positionSizePct, paramRec.positionSizePct)
      : 0;

    // Build reasoning
    const reasoningParts: string[] = [];

    if (!qLearningHasData) {
      reasoningParts.push('🆕 Estado nuevo - GPT decide');
    } else if (qResult.isExploration) {
      reasoningParts.push('🔍 Exploración Q-Learning');
    } else {
      reasoningParts.push(`📊 Q-Action: ${qResult.action} (Q=${maxQValue.toFixed(2)})`);
    }

    if (paramRec.reasoning) {
      reasoningParts.push(paramRec.reasoning);
    }

    // Log snapshot for learning
    await this.logMarketSnapshot(marketState, qResult.stateKey, qResult.action);

    return {
      shouldTrade,
      action: qResult.action,
      confidence: Math.max(qResult.confidence, gptConfidence),
      leverage: finalLeverage,
      positionSizePct: finalPositionSize,
      tpPct: paramRec.tpPct,
      slPct: paramRec.slPct,
      stateKey: qResult.stateKey,
      reasoning: reasoningParts.join(' | '),
      isExploration: qResult.isExploration,
      qValues: qResult.qValues
    };
  }

  /**
   * Learn from trade result
   */
  async learn(result: TradeResult): Promise<void> {
    // Calculate reward
    const reward = this.qAgent.calculateReward({
      pnlPct: result.pnlPct,
      exitReason: result.exitReason,
      leverage: result.leverage,
      duration: result.duration
    });

    // Update Q-Learning
    await this.qAgent.learn(result.stateKey, result.action, reward);

    // Update trade count
    this.totalTrades++;

    // Update market snapshot with result
    await this.updateSnapshotResult(
      result.stateKey,
      result.action,
      result.pnlPct > 0 ? 'WIN' : 'LOSS',
      reward
    );

    // Check if we should optimize parameters
    const metrics = await this.getPerformanceMetrics();
    if (await this.paramOptimizer.shouldOptimize(metrics)) {
      const optResult = await this.paramOptimizer.optimize(metrics);
      if (optResult.changed) {
        console.log(`[AdaptiveLearning] Parameters optimized: ${optResult.strategy}`);
        console.log(`[AdaptiveLearning] Changes: ${optResult.changes.map(c => `${c.param}: ${c.oldValue.toFixed(2)} -> ${c.newValue.toFixed(2)}`).join(', ')}`);
      }
    }

    console.log(`[AdaptiveLearning] Learned from trade: ${result.pnlPct > 0 ? '✅ WIN' : '❌ LOSS'} | Reward: ${reward.toFixed(2)}`);
  }

  /**
   * Get performance metrics for optimization
   */
  private async getPerformanceMetrics(): Promise<{
    winRate: number;
    roi: number;
    maxDrawdown: number;
    totalTrades: number;
    recentTrades: number;
    avgPnl: number;
    profitFactor: number;
  }> {
    try {
      const trades = await prisma.trade.findMany({
        orderBy: { entryTime: 'desc' },
        take: 100
      });

      if (trades.length === 0) {
        return {
          winRate: 0,
          roi: 0,
          maxDrawdown: 0,
          totalTrades: 0,
          recentTrades: 0,
          avgPnl: 0,
          profitFactor: 1
        };
      }

      const completedTrades = trades.filter((t: any) => t.pnl !== null);
      const wins = completedTrades.filter((t: any) => (t.pnl || 0) > 0);
      const losses = completedTrades.filter((t: any) => (t.pnl || 0) <= 0);

      const winRate = completedTrades.length > 0
        ? (wins.length / completedTrades.length) * 100
        : 0;

      const totalPnl = completedTrades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
      const avgPnl = completedTrades.length > 0 ? totalPnl / completedTrades.length : 0;

      const totalWins = wins.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);
      const totalLosses = Math.abs(losses.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0));
      const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 1;

      // Calculate max drawdown from recent trades
      let maxDrawdown = 0;
      let peak = 0;
      let cumPnl = 0;

      for (const trade of completedTrades.reverse()) {
        cumPnl += trade.pnl || 0;
        if (cumPnl > peak) peak = cumPnl;
        const drawdown = peak > 0 ? ((peak - cumPnl) / peak) * 100 : 0;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      }

      // Count recent trades (last 24h)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentTrades = trades.filter((t: any) => t.entryTime > oneDayAgo).length;

      return {
        winRate,
        roi: totalPnl,
        maxDrawdown,
        totalTrades: this.totalTrades,
        recentTrades,
        avgPnl,
        profitFactor
      };
    } catch (error) {
      console.error('[AdaptiveLearning] Error getting metrics:', error);
      return {
        winRate: 0,
        roi: 0,
        maxDrawdown: 0,
        totalTrades: 0,
        recentTrades: 0,
        avgPnl: 0,
        profitFactor: 1
      };
    }
  }

  /**
   * Log market snapshot for analysis
   */
  private async logMarketSnapshot(
    state: MarketState,
    stateKey: string,
    action: ActionType
  ): Promise<void> {
    try {
      await prisma.marketSnapshot.create({
        data: {
          symbol: state.symbol,
          signal: state.signal,
          rsi: state.rsi,
          rsiZone: state.rsi <= 30 ? 'LOW' : state.rsi >= 70 ? 'HIGH' : 'NEUTRAL',
          macdHistogram: 0, // Will be filled by trading engine
          regime: state.regime,
          regimeStrength: state.regimeStrength,
          orderbook: state.orderbook,
          volatility: state.volatility > 3 ? 'VERY_HIGH' : state.volatility > 2 ? 'HIGH' : state.volatility > 1 ? 'MEDIUM' : 'LOW',
          volatilityPct: state.volatility,
          fearGreedIndex: state.fearGreedIndex,
          fearGreedZone: state.fearGreedIndex <= 24 ? 'EXTREME_FEAR' : state.fearGreedIndex <= 40 ? 'FEAR' : state.fearGreedIndex >= 76 ? 'EXTREME_GREED' : 'NEUTRAL',
          stateKey,
          actionTaken: action
        }
      });
    } catch (error) {
      // Ignore logging errors
    }
  }

  /**
   * Update snapshot with trade result
   */
  private async updateSnapshotResult(
    stateKey: string,
    action: ActionType,
    result: 'WIN' | 'LOSS' | 'SKIP',
    reward: number
  ): Promise<void> {
    try {
      const snapshot = await prisma.marketSnapshot.findFirst({
        where: { stateKey, actionTaken: action },
        orderBy: { timestamp: 'desc' }
      });

      if (snapshot) {
        await prisma.marketSnapshot.update({
          where: { id: snapshot.id },
          data: { actionResult: result, reward }
        });
      }
    } catch (error) {
      // Ignore update errors
    }
  }

  /**
   * Get current system statistics
   */
  async getStats(): Promise<{
    qLearning: ReturnType<QLearningAgent['getStats']>;
    params: ReturnType<ParameterOptimizer['getParams']>;
    performance: {
      winRate: number;
      roi: number;
      maxDrawdown: number;
      totalTrades: number;
      recentTrades: number;
      avgPnl: number;
      profitFactor: number;
    };
    totalStates: number;
  }> {
    const totalStates = await prisma.qState.count();

    return {
      qLearning: this.qAgent.getStats(),
      params: this.paramOptimizer.getParams(),
      performance: await this.getPerformanceMetrics(),
      totalStates
    };
  }

  /**
   * Get best states from Q-table
   */
  async getBestStates(limit: number = 10): Promise<Array<{
    stateKey: string;
    bestAction: string;
    bestValue: number;
    winRate: number;
  }>> {
    const states = await prisma.qState.findMany({
      orderBy: { avgReward: 'desc' },
      take: limit
    });

    return states.map((s: any) => {
      const values = {
        SKIP: s.skipValue,
        OPEN_CONSERVATIVE: s.openConservative,
        OPEN_NORMAL: s.openNormal,
        OPEN_AGGRESSIVE: s.openAggressive,
        FUTURES_LOW: s.futuresLow,
        FUTURES_MEDIUM: s.futuresMedium,
        FUTURES_HIGH: s.futuresHigh
      };

      const bestEntry = Object.entries(values).reduce((a, b) => a[1] > b[1] ? a : b);

      return {
        stateKey: s.stateKey,
        bestAction: bestEntry[0],
        bestValue: bestEntry[1],
        winRate: s.visits > 0 ? (s.winCount / s.visits) * 100 : 0
      };
    });
  }
}

// Export singleton instance
export const adaptiveLearning = new AdaptiveLearningSystem();

// Re-export types and utilities
export { stateEncoder, MarketState, ActionType } from './stateEncoder';
export { qLearningAgent } from './qLearningAgent';
export { parameterOptimizer } from './parameterOptimizer';
