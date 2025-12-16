/**
 * State Encoder - Encodes market conditions into Q-Learning states
 * Based on the 87.95% win rate IA architecture
 */

export interface MarketState {
  symbol: string;
  signal: 'BUY' | 'SELL' | 'NEUTRAL';
  rsi: number;
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS';
  regimeStrength: 'WEAK' | 'MODERATE' | 'STRONG';
  orderbook: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  volatility: number; // percentage
  tradeCount: number; // total trades so far
  fearGreedIndex: number;
  mlSignal?: 'BUY' | 'SELL' | 'NONE';
  newsScore?: number;
  sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

export type ActionType =
  | 'SKIP'
  | 'OPEN_CONSERVATIVE'
  | 'OPEN_NORMAL'
  | 'OPEN_AGGRESSIVE'
  | 'FUTURES_LOW'
  | 'FUTURES_MEDIUM'
  | 'FUTURES_HIGH';

export class StateEncoder {
  /**
   * Encode RSI into zones
   */
  private encodeRsiZone(rsi: number): string {
    if (rsi <= 20) return 'OVERSOLD';
    if (rsi <= 30) return 'LOW';
    if (rsi <= 40) return 'NEUTRAL';
    if (rsi <= 60) return 'NEUTRAL';
    if (rsi <= 70) return 'HIGH';
    return 'OVERBOUGHT';
  }

  /**
   * Encode volatility into categories
   */
  private encodeVolatility(volatilityPct: number): string {
    if (volatilityPct < 1) return 'LOW';
    if (volatilityPct < 2) return 'MEDIUM';
    if (volatilityPct < 3) return 'HIGH';
    return 'VERY_HIGH';
  }

  /**
   * Encode trade count into experience zones
   */
  private encodeTradeCount(count: number): string {
    if (count < 50) return 'TC_0_50';
    if (count < 100) return 'TC_50_100';
    if (count < 150) return 'TC_100_150';
    return 'TC_150_500';
  }

  /**
   * Encode Fear & Greed index
   */
  private encodeFearGreed(index: number): string {
    if (index <= 24) return 'FG_EXTREME_FEAR';
    if (index <= 40) return 'FG_FEAR';
    if (index <= 60) return 'FG_NEUTRAL';
    if (index <= 75) return 'FG_GREED';
    return 'FG_EXTREME_GREED';
  }

  /**
   * Encode ML signal
   */
  private encodeMlSignal(signal?: 'BUY' | 'SELL' | 'NONE'): string {
    return `ML_${signal || 'NONE'}`;
  }

  /**
   * Encode news/sentiment
   */
  private encodeSentiment(sentiment?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'): string {
    if (!sentiment || sentiment === 'NEUTRAL') return 'NEWS_NO_SENT_NEU';
    if (sentiment === 'POSITIVE') return 'NEWS_YES_SENT_POS';
    return 'NEWS_YES_SENT_NEG';
  }

  /**
   * Generate full state key for Q-table lookup
   * Format: SYMBOL_SIGNAL_RSI_REGIME_STRENGTH_ORDERBOOK_VOL_TC_FG_ML_NEWS_SENT
   */
  encodeState(state: MarketState): string {
    const parts = [
      state.symbol.replace('/', '_').replace('USDT', '/USDT'),
      state.signal,
      this.encodeRsiZone(state.rsi),
      state.regime,
      state.regimeStrength,
      state.orderbook,
      this.encodeVolatility(state.volatility),
      this.encodeTradeCount(state.tradeCount),
      this.encodeFearGreed(state.fearGreedIndex),
      this.encodeMlSignal(state.mlSignal),
      this.encodeSentiment(state.sentiment)
    ];

    return parts.join('_');
  }

  /**
   * Generate a simplified state key (for when we have less data)
   */
  encodeSimplifiedState(state: Partial<MarketState>): string {
    const parts = [
      state.symbol?.replace('/', '_').replace('USDT', '/USDT') || 'UNKNOWN',
      state.signal || 'NEUTRAL',
      this.encodeRsiZone(state.rsi || 50),
      state.regime || 'SIDEWAYS',
      state.regimeStrength || 'MODERATE',
      state.orderbook || 'NEUTRAL',
      this.encodeVolatility(state.volatility || 1),
      this.encodeTradeCount(state.tradeCount || 0),
      this.encodeFearGreed(state.fearGreedIndex || 50),
      'ML_NONE',
      'NEWS_NO_SENT_NEU'
    ];

    return parts.join('_');
  }

  /**
   * Decode a state key back into components
   */
  decodeState(stateKey: string): Partial<MarketState> {
    const parts = stateKey.split('_');

    // Parse components (best effort)
    return {
      symbol: parts[0]?.replace('_', '/'),
      signal: parts[1] as 'BUY' | 'SELL' | 'NEUTRAL',
      regime: parts[3] as 'BULL' | 'BEAR' | 'SIDEWAYS',
      regimeStrength: parts[4] as 'WEAK' | 'MODERATE' | 'STRONG',
      orderbook: parts[5] as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    };
  }

  /**
   * Get all possible actions
   */
  getActions(): ActionType[] {
    return [
      'SKIP',
      'OPEN_CONSERVATIVE',
      'OPEN_NORMAL',
      'OPEN_AGGRESSIVE',
      'FUTURES_LOW',
      'FUTURES_MEDIUM',
      'FUTURES_HIGH'
    ];
  }

  /**
   * Convert action to trading parameters
   */
  actionToParams(action: ActionType, params: {
    basePositionPct: number;
    conservativeLev: number;
    balancedLev: number;
    aggressiveLev: number;
  }): {
    shouldTrade: boolean;
    positionSizePct: number;
    leverage: number;
    riskLevel: 'low' | 'medium' | 'high';
  } {
    switch (action) {
      case 'SKIP':
        return { shouldTrade: false, positionSizePct: 0, leverage: 1, riskLevel: 'low' };

      case 'OPEN_CONSERVATIVE':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct * 0.5,
          leverage: 1,
          riskLevel: 'low'
        };

      case 'OPEN_NORMAL':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct * 0.75,
          leverage: 1,
          riskLevel: 'medium'
        };

      case 'OPEN_AGGRESSIVE':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct,
          leverage: 1,
          riskLevel: 'high'
        };

      case 'FUTURES_LOW':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct * 0.6,
          leverage: params.conservativeLev,
          riskLevel: 'medium'
        };

      case 'FUTURES_MEDIUM':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct * 0.8,
          leverage: params.balancedLev,
          riskLevel: 'medium'
        };

      case 'FUTURES_HIGH':
        return {
          shouldTrade: true,
          positionSizePct: params.basePositionPct,
          leverage: params.aggressiveLev,
          riskLevel: 'high'
        };

      default:
        return { shouldTrade: false, positionSizePct: 0, leverage: 1, riskLevel: 'low' };
    }
  }
}

export const stateEncoder = new StateEncoder();
