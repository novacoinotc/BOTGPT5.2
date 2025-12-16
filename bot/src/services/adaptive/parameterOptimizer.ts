/**
 * Parameter Optimizer - Dynamically adjusts trading parameters based on performance
 * Based on the 87.95% win rate IA architecture (93 parameters, 236 trials)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Optimal parameters from the 87.95% WR IA (after 236 trials)
const OPTIMAL_PARAMS = {
  // Trading Thresholds
  minConfidence: 55,
  profitThreshold: 1.67,

  // RSI Configuration
  rsiOversold: 26,
  rsiOverbought: 74,
  rsiPeriod: 10,

  // Position Sizing
  basePositionPct: 7.43,
  maxPositionPct: 11.74,
  maxRiskPerTrade: 2.89,
  maxPositions: 5,

  // Leverage Settings (capped at 10x for Binance)
  conservativeLev: 5,
  balancedLev: 7,
  aggressiveLev: 10,

  // Futures Conditions
  minConfFutures: 75.68,
  minWinrateFutures: 46.13,
  maxDrawdownFutures: 6.11,
  volThresholdFutures: 0.025,

  // Fear & Greed
  fgExtremeThreshold: 24,
  fgOpportunityBoost: 1.85,

  // Take Profit
  tpBasePct: 0.31,
  tpDynamicMultiplier: 1.92,

  // Stop Loss
  slBasePct: 0.30
};

type OptimizationStrategy = 'OPTIMIZATION' | 'EXPLORATION' | 'RECOVERY' | 'AGGRESSIVE';

interface PerformanceMetrics {
  winRate: number;
  roi: number;
  maxDrawdown: number;
  totalTrades: number;
  recentTrades: number;
  avgPnl: number;
  profitFactor: number;
}

export class ParameterOptimizer {
  private params: typeof OPTIMAL_PARAMS;
  private changeCount: number = 0;

  constructor() {
    this.params = { ...OPTIMAL_PARAMS };
  }

  /**
   * Load parameters from database or use defaults
   */
  async loadParams(): Promise<typeof OPTIMAL_PARAMS> {
    try {
      const dbParams = await prisma.dynamicParams.findUnique({
        where: { id: 'active' }
      });

      if (dbParams) {
        this.params = {
          minConfidence: dbParams.minConfidence,
          profitThreshold: dbParams.profitThreshold,
          rsiOversold: dbParams.rsiOversold,
          rsiOverbought: dbParams.rsiOverbought,
          rsiPeriod: dbParams.rsiPeriod,
          basePositionPct: dbParams.basePositionPct,
          maxPositionPct: dbParams.maxPositionPct,
          maxRiskPerTrade: dbParams.maxRiskPerTrade,
          maxPositions: dbParams.maxPositions,
          conservativeLev: dbParams.conservativeLev,
          balancedLev: dbParams.balancedLev,
          aggressiveLev: dbParams.aggressiveLev,
          minConfFutures: dbParams.minConfFutures,
          minWinrateFutures: dbParams.minWinrateFutures,
          maxDrawdownFutures: dbParams.maxDrawdownFutures,
          volThresholdFutures: dbParams.volThresholdFutures,
          fgExtremeThreshold: dbParams.fgExtremeThreshold,
          fgOpportunityBoost: dbParams.fgOpportunityBoost,
          tpBasePct: dbParams.tpBasePct,
          tpDynamicMultiplier: dbParams.tpDynamicMultiplier,
          slBasePct: dbParams.slBasePct
        };
      }
    } catch (error) {
      console.log('[ParamOptimizer] Using default optimal parameters');
    }

    return this.params;
  }

  /**
   * Get current parameters
   */
  getParams(): typeof OPTIMAL_PARAMS {
    return { ...this.params };
  }

  /**
   * Initialize parameters in database
   */
  async initializeParams(): Promise<void> {
    try {
      await prisma.dynamicParams.upsert({
        where: { id: 'active' },
        create: {
          id: 'active',
          ...OPTIMAL_PARAMS
        },
        update: {} // Don't overwrite if exists
      });
      console.log('[ParamOptimizer] Parameters initialized from 87.95% WR IA');
    } catch (error) {
      console.error('[ParamOptimizer] Error initializing params:', error);
    }
  }

  /**
   * Determine optimization strategy based on performance
   */
  private determineStrategy(metrics: PerformanceMetrics): OptimizationStrategy {
    const { winRate, roi, maxDrawdown, totalTrades } = metrics;

    // Too few trades to optimize
    if (totalTrades < 10) {
      return 'EXPLORATION';
    }

    // Excellent performance - fine-tune
    if (winRate >= 75 && roi > 0) {
      return 'AGGRESSIVE';
    }

    // Good performance - optimize
    if (winRate >= 60 && roi > 0) {
      return 'OPTIMIZATION';
    }

    // Poor performance or high drawdown - recover
    if (winRate < 50 || maxDrawdown > 15 || roi < -5) {
      return 'RECOVERY';
    }

    // Default - explore
    return 'EXPLORATION';
  }

  /**
   * Check if optimization should run
   */
  async shouldOptimize(metrics: PerformanceMetrics): Promise<boolean> {
    // Optimize every 10-20 trades depending on performance
    const interval = metrics.winRate >= 60 ? 20 : 10;
    return metrics.recentTrades >= interval;
  }

  /**
   * Optimize parameters based on recent performance
   */
  async optimize(metrics: PerformanceMetrics): Promise<{
    changed: boolean;
    strategy: OptimizationStrategy;
    changes: Array<{ param: string; oldValue: number; newValue: number }>;
    reasoning: string;
  }> {
    const strategy = this.determineStrategy(metrics);
    const changes: Array<{ param: string; oldValue: number; newValue: number }> = [];
    let reasoning = '';

    console.log(`[ParamOptimizer] Strategy: ${strategy} | WR: ${metrics.winRate.toFixed(1)}% | ROI: ${metrics.roi.toFixed(2)}%`);

    switch (strategy) {
      case 'AGGRESSIVE':
        // High performance - increase position sizes and leverage
        reasoning = `🎯 Excelente rendimiento (WR: ${metrics.winRate.toFixed(1)}%) - Aumentando agresividad`;

        if (this.params.basePositionPct < 10) {
          const oldVal = this.params.basePositionPct;
          this.params.basePositionPct = Math.min(10, this.params.basePositionPct * 1.1);
          changes.push({ param: 'basePositionPct', oldValue: oldVal, newValue: this.params.basePositionPct });
        }

        if (this.params.aggressiveLev < 15) {
          const oldVal = this.params.aggressiveLev;
          this.params.aggressiveLev = Math.min(15, this.params.aggressiveLev + 1);
          changes.push({ param: 'aggressiveLev', oldValue: oldVal, newValue: this.params.aggressiveLev });
        }

        // Lower confidence threshold to catch more opportunities
        if (this.params.minConfidence > 50) {
          const oldVal = this.params.minConfidence;
          this.params.minConfidence = Math.max(50, this.params.minConfidence - 5);
          changes.push({ param: 'minConfidence', oldValue: oldVal, newValue: this.params.minConfidence });
        }
        break;

      case 'OPTIMIZATION':
        // Good performance - small refinements
        reasoning = `📈 Buen rendimiento (WR: ${metrics.winRate.toFixed(1)}%) - Optimizando incrementalmente`;

        // Adjust TP based on average win
        if (metrics.avgPnl > this.params.tpBasePct * 2) {
          const oldVal = this.params.tpBasePct;
          this.params.tpBasePct = Math.min(0.5, this.params.tpBasePct * 1.05);
          changes.push({ param: 'tpBasePct', oldValue: oldVal, newValue: this.params.tpBasePct });
        }

        // Slight leverage increase if drawdown is low
        if (metrics.maxDrawdown < 10 && this.params.balancedLev < 8) {
          const oldVal = this.params.balancedLev;
          this.params.balancedLev = Math.min(8, this.params.balancedLev + 1);
          changes.push({ param: 'balancedLev', oldValue: oldVal, newValue: this.params.balancedLev });
        }
        break;

      case 'RECOVERY':
        // Poor performance - reduce risk significantly
        reasoning = `⚠️ Rendimiento bajo (WR: ${metrics.winRate.toFixed(1)}%, DD: ${metrics.maxDrawdown.toFixed(1)}%) - Modo conservador`;

        // Reduce position sizes
        if (this.params.basePositionPct > 3) {
          const oldVal = this.params.basePositionPct;
          this.params.basePositionPct = Math.max(3, this.params.basePositionPct * 0.8);
          changes.push({ param: 'basePositionPct', oldValue: oldVal, newValue: this.params.basePositionPct });
        }

        // Reduce leverage
        if (this.params.aggressiveLev > 5) {
          const oldVal = this.params.aggressiveLev;
          this.params.aggressiveLev = Math.max(5, this.params.aggressiveLev - 2);
          changes.push({ param: 'aggressiveLev', oldValue: oldVal, newValue: this.params.aggressiveLev });
        }

        // Increase confidence threshold
        if (this.params.minConfidence < 70) {
          const oldVal = this.params.minConfidence;
          this.params.minConfidence = Math.min(70, this.params.minConfidence + 10);
          changes.push({ param: 'minConfidence', oldValue: oldVal, newValue: this.params.minConfidence });
        }

        // Tighter stop loss
        if (this.params.slBasePct > 0.2) {
          const oldVal = this.params.slBasePct;
          this.params.slBasePct = Math.max(0.2, this.params.slBasePct * 0.9);
          changes.push({ param: 'slBasePct', oldValue: oldVal, newValue: this.params.slBasePct });
        }
        break;

      case 'EXPLORATION':
        // Few trades - explore different configurations
        reasoning = `🔍 Explorando (${metrics.totalTrades} trades) - Probando configuraciones`;

        // Random small variations to learn
        const explorationFactor = 0.1;
        const paramsToVary = ['tpBasePct', 'slBasePct', 'minConfidence'];

        for (const param of paramsToVary) {
          if (Math.random() < 0.3) { // 30% chance to vary each param
            const oldVal = this.params[param as keyof typeof this.params] as number;
            const variation = 1 + (Math.random() - 0.5) * explorationFactor;
            const newVal = oldVal * variation;

            (this.params as any)[param] = newVal;
            changes.push({ param, oldValue: oldVal, newValue: newVal });
          }
        }
        break;
    }

    // Save changes to database
    if (changes.length > 0) {
      this.changeCount++;
      await this.saveParams(metrics, strategy, changes, reasoning);
    }

    return {
      changed: changes.length > 0,
      strategy,
      changes,
      reasoning
    };
  }

  /**
   * Save parameters and log change history
   */
  private async saveParams(
    metrics: PerformanceMetrics,
    strategy: OptimizationStrategy,
    changes: Array<{ param: string; oldValue: number; newValue: number }>,
    reasoning: string
  ): Promise<void> {
    try {
      // Update current parameters
      await prisma.dynamicParams.upsert({
        where: { id: 'active' },
        create: {
          id: 'active',
          ...this.params,
          currentWinRate: metrics.winRate,
          currentROI: metrics.roi,
          totalTrials: this.changeCount,
          lastOptimization: new Date()
        },
        update: {
          ...this.params,
          currentWinRate: metrics.winRate,
          currentROI: metrics.roi,
          totalTrials: { increment: 1 },
          lastOptimization: new Date()
        }
      });

      // Log change history
      await prisma.paramChange.create({
        data: {
          changeNumber: this.changeCount,
          triggerReason: `WR: ${metrics.winRate.toFixed(1)}%, ROI: ${metrics.roi.toFixed(2)}%`,
          strategy,
          winRateBefore: metrics.winRate,
          roiBefore: metrics.roi,
          drawdownBefore: metrics.maxDrawdown,
          paramsChanged: changes,
          reasoning,
          totalTradesAtChange: metrics.totalTrades
        }
      });

      console.log(`[ParamOptimizer] Saved ${changes.length} parameter changes (trial #${this.changeCount})`);
    } catch (error) {
      console.error('[ParamOptimizer] Error saving params:', error);
    }
  }

  /**
   * Calculate dynamic take profit based on volatility and conditions
   * From IA: TP1=0.31%, TP2=1.20%, TP3=1.45% - we use dynamic single TP
   */
  calculateDynamicTP(baseTP: number, volatility: number, regime: string, regimeStrength?: string, fearGreed?: number): number {
    let tp = baseTP;

    // Base multiplier from params
    let multiplier = this.params.tpDynamicMultiplier; // 1.92x

    // HIGH VOLATILITY = Higher TP potential (from IA patterns)
    if (volatility > 3) {
      multiplier *= 1.5; // Can capture 1.5x more in high vol
    } else if (volatility > 2) {
      multiplier *= 1.3;
    } else if (volatility < 1) {
      multiplier *= 0.8; // Lower TP in low volatility
    }

    // STRONG TREND = Higher TP (from IA: strong trends captured more)
    if (regime === 'BEAR' || regime === 'BULL') {
      if (regimeStrength === 'STRONG') {
        multiplier *= 1.4; // Strong trends = bigger moves
      } else if (regimeStrength === 'MODERATE') {
        multiplier *= 1.2;
      }
    }

    // EXTREME FEAR/GREED = Higher TP potential (contrarian moves are strong)
    if (fearGreed !== undefined) {
      if (fearGreed <= 20 || fearGreed >= 80) {
        multiplier *= 1.3; // Extreme sentiment = stronger reversals
      }
    }

    tp = baseTP * multiplier;

    // Cap TP between 0.3% and 2.5% (from IA range)
    return Math.max(0.3, Math.min(2.5, tp));
  }

  /**
   * Calculate dynamic stop loss based on ATR and regime
   */
  calculateDynamicSL(baseSL: number, atr: number, regime: string): number {
    let sl = baseSL;

    // Tighter stops in ranging markets
    if (regime === 'SIDEWAYS') {
      sl *= 0.8;
    }

    // Wider stops in high volatility (to avoid noise)
    if (atr > 2) {
      sl *= 1.2;
    }

    return Math.max(0.15, Math.min(1.0, sl)); // Keep between 0.15% and 1%
  }

  /**
   * Determine optimal leverage based on conditions
   */
  calculateOptimalLeverage(
    confidence: number,
    regime: string,
    volatility: number,
    fearGreed: number,
    winRate: number
  ): number {
    // Start with base leverage
    let leverage = this.params.conservativeLev;

    // High confidence + strong trend = higher leverage
    if (confidence >= 80 && (regime === 'BEAR' || regime === 'BULL')) {
      leverage = this.params.aggressiveLev;
    } else if (confidence >= 65) {
      leverage = this.params.balancedLev;
    }

    // Fear & Greed extreme = opportunity with leverage
    if (fearGreed <= this.params.fgExtremeThreshold || fearGreed >= (100 - this.params.fgExtremeThreshold)) {
      leverage = Math.min(leverage + 2, this.params.aggressiveLev);
    }

    // High volatility = reduce leverage
    if (volatility > 3) {
      leverage = Math.max(1, leverage - 2);
    }

    // Low win rate = reduce leverage
    if (winRate < 50) {
      leverage = Math.max(1, Math.floor(leverage / 2));
    }

    return Math.min(leverage, 10); // Cap at 10x (Binance limit)
  }

  /**
   * Get recommended action for GPT
   */
  getRecommendation(params: {
    confidence: number;
    regime: string;
    regimeStrength: string;
    volatility: number;
    fearGreed: number;
    rsi: number;
    signal: string;
  }): {
    shouldTrade: boolean;
    leverage: number;
    positionSizePct: number;
    tpPct: number;
    slPct: number;
    reasoning: string;
  } {
    const { confidence, regime, regimeStrength, volatility, fearGreed, rsi, signal } = params;

    // Check minimum confidence
    if (confidence < this.params.minConfidence) {
      return {
        shouldTrade: false,
        leverage: 1,
        positionSizePct: 0,
        tpPct: 0,
        slPct: 0,
        reasoning: `Confianza ${confidence}% < mínimo ${this.params.minConfidence}%`
      };
    }

    // Check RSI extremes
    const isOversold = rsi <= this.params.rsiOversold;
    const isOverbought = rsi >= this.params.rsiOverbought;

    // Build reasoning
    const reasons: string[] = [];

    // Calculate position size
    let positionSizePct = this.params.basePositionPct;
    if (confidence >= 80) {
      positionSizePct = this.params.maxPositionPct;
      reasons.push(`Alta confianza (${confidence}%)`);
    } else if (confidence >= 65) {
      positionSizePct = (this.params.basePositionPct + this.params.maxPositionPct) / 2;
    }

    // Calculate leverage
    const leverage = this.calculateOptimalLeverage(confidence, regime, volatility, fearGreed, 60);

    // Fear & Greed opportunity
    if (fearGreed <= this.params.fgExtremeThreshold) {
      reasons.push(`Miedo extremo (${fearGreed}) = oportunidad SHORT`);
    } else if (fearGreed >= (100 - this.params.fgExtremeThreshold)) {
      reasons.push(`Codicia extrema (${fearGreed}) = precaución`);
    }

    // Regime alignment
    if (signal === 'SELL' && regime === 'BEAR' && regimeStrength === 'STRONG') {
      reasons.push('SHORT alineado con tendencia bajista fuerte');
    } else if (signal === 'BUY' && regime === 'BULL' && regimeStrength === 'STRONG') {
      reasons.push('LONG alineado con tendencia alcista fuerte');
    }

    // RSI conditions
    if (isOversold && signal === 'BUY') {
      reasons.push(`RSI sobreventa (${rsi}) - posible rebote`);
    } else if (isOverbought && signal === 'SELL') {
      reasons.push(`RSI sobrecompra (${rsi}) - posible caída`);
    }

    // Calculate TP and SL with full context for dynamic adjustment
    const tpPct = this.calculateDynamicTP(this.params.tpBasePct, volatility, regime, regimeStrength, fearGreed);
    const slPct = this.calculateDynamicSL(this.params.slBasePct, volatility / 100, regime);

    return {
      shouldTrade: true,
      leverage,
      positionSizePct,
      tpPct,
      slPct,
      reasoning: reasons.join(' | ')
    };
  }
}

export const parameterOptimizer = new ParameterOptimizer();
