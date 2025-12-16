/**
 * Q-Learning Agent - Learns optimal actions from trade outcomes
 * Based on the 87.95% win rate IA architecture
 */

import { PrismaClient } from '@prisma/client';
import { stateEncoder, MarketState, ActionType } from './stateEncoder';

const prisma = new PrismaClient();

// Pre-trained Q-values from the 87.95% win rate IA
const PRETRAINED_Q_VALUES: Record<string, Record<ActionType, number>> = {
  // Top performing states from the IA
  'TIA/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 74.68
  },
  'CRV/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 60.00,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'NEAR/USDT_SELL_LOW_SIDEWAYS_MODERATE_NEUTRAL_VERY_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 30.27, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'CRV/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 29.66
  },
  'LTC/USDT_SELL_LOW_BEAR_WEAK_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 27.25
  },
  'SEI/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 21.65
  },
  'ETH/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 16.09,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'ADA/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 16.00,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'AVAX/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_50_100_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 14.00, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'LINK/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 13.15, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'INJ/USDT_SELL_LOW_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 10.82
  },
  'AVAX/USDT_SELL_NEUTRAL_BEAR_STRONG_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 10.47, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'CRV/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_50_100_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 9.59
  },
  'BTC/USDT_SELL_NEUTRAL_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 6.04, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 7.11
  },
  'TON/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_100_150_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 6.10, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
  'TON/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_150_500_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 5.88
  },
  'ETH/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_50_100_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 0, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 5.03, 'FUTURES_HIGH': 0
  },
  'XRP/USDT_SELL_LOW_BEAR_MODERATE_NEUTRAL_VERY_HIGH_TC_50_100_FG_EXTREME_FEAR_ML_NONE_NEWS_NO_SENT_NEU': {
    'SKIP': 0, 'OPEN_CONSERVATIVE': 0, 'OPEN_NORMAL': 5.17, 'OPEN_AGGRESSIVE': 0,
    'FUTURES_LOW': 0, 'FUTURES_MEDIUM': 0, 'FUTURES_HIGH': 0
  },
};

export interface QAgentConfig {
  learningRate: number;      // Alpha - how much new info overrides old (0.1)
  discountFactor: number;    // Gamma - importance of future rewards (0.95)
  explorationRate: number;   // Epsilon - probability of random action (starts at 0.1)
  minExploration: number;    // Minimum exploration rate (0.05)
  explorationDecay: number;  // How fast exploration decreases (0.995)
}

const DEFAULT_CONFIG: QAgentConfig = {
  learningRate: 0.1,
  discountFactor: 0.95,
  explorationRate: 0.1,
  minExploration: 0.05,
  explorationDecay: 0.995
};

export class QLearningAgent {
  private config: QAgentConfig;
  private totalReward: number = 0;
  private episodeCount: number = 0;

  constructor(config: Partial<QAgentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get Q-values for a state from database
   */
  async getQValues(stateKey: string): Promise<Record<ActionType, number>> {
    try {
      const state = await prisma.qState.findUnique({
        where: { stateKey }
      });

      if (state) {
        return {
          'SKIP': state.skipValue,
          'OPEN_CONSERVATIVE': state.openConservative,
          'OPEN_NORMAL': state.openNormal,
          'OPEN_AGGRESSIVE': state.openAggressive,
          'FUTURES_LOW': state.futuresLow,
          'FUTURES_MEDIUM': state.futuresMedium,
          'FUTURES_HIGH': state.futuresHigh
        };
      }

      // Check pre-trained values
      if (PRETRAINED_Q_VALUES[stateKey]) {
        return PRETRAINED_Q_VALUES[stateKey];
      }

      // Return zeros for new state
      return {
        'SKIP': 0,
        'OPEN_CONSERVATIVE': 0,
        'OPEN_NORMAL': 0,
        'OPEN_AGGRESSIVE': 0,
        'FUTURES_LOW': 0,
        'FUTURES_MEDIUM': 0,
        'FUTURES_HIGH': 0
      };
    } catch (error) {
      console.error('Error getting Q-values:', error);
      return PRETRAINED_Q_VALUES[stateKey] || {
        'SKIP': 0,
        'OPEN_CONSERVATIVE': 0,
        'OPEN_NORMAL': 0,
        'OPEN_AGGRESSIVE': 0,
        'FUTURES_LOW': 0,
        'FUTURES_MEDIUM': 0,
        'FUTURES_HIGH': 0
      };
    }
  }

  /**
   * Select best action for a state (with exploration)
   */
  async selectAction(marketState: MarketState, explore: boolean = true): Promise<{
    action: ActionType;
    confidence: number;
    isExploration: boolean;
    stateKey: string;
    qValues: Record<ActionType, number>;
  }> {
    const stateKey = stateEncoder.encodeState(marketState);
    const qValues = await this.getQValues(stateKey);
    const actions = stateEncoder.getActions();

    // Exploration vs Exploitation
    let selectedAction: ActionType;
    let isExploration = false;

    if (explore && Math.random() < this.config.explorationRate) {
      // Random action for exploration
      selectedAction = actions[Math.floor(Math.random() * actions.length)];
      isExploration = true;
    } else {
      // Best action based on Q-values
      selectedAction = this.getBestAction(qValues);
    }

    // Calculate confidence based on Q-value magnitude and visits
    const maxQ = Math.max(...Object.values(qValues));
    const confidence = Math.min(100, Math.max(0, maxQ * 10 + 50));

    return {
      action: selectedAction,
      confidence,
      isExploration,
      stateKey,
      qValues
    };
  }

  /**
   * Get best action from Q-values
   */
  private getBestAction(qValues: Record<ActionType, number>): ActionType {
    let bestAction: ActionType = 'SKIP';
    let bestValue = -Infinity;

    for (const [action, value] of Object.entries(qValues)) {
      if (value > bestValue) {
        bestValue = value;
        bestAction = action as ActionType;
      }
    }

    // If all values are 0 or negative, prefer SKIP for safety
    if (bestValue <= 0) {
      return 'SKIP';
    }

    return bestAction;
  }

  /**
   * Update Q-value after trade result (learning)
   */
  async learn(
    stateKey: string,
    action: ActionType,
    reward: number,
    nextStateKey?: string
  ): Promise<void> {
    try {
      // Get current Q-values
      const currentQ = await this.getQValues(stateKey);
      const oldValue = currentQ[action];

      // Get max Q-value of next state (for future reward estimation)
      let maxNextQ = 0;
      if (nextStateKey) {
        const nextQ = await this.getQValues(nextStateKey);
        maxNextQ = Math.max(...Object.values(nextQ));
      }

      // Q-Learning update formula:
      // Q(s,a) = Q(s,a) + α * (reward + γ * max(Q(s',a')) - Q(s,a))
      const newValue = oldValue + this.config.learningRate * (
        reward + this.config.discountFactor * maxNextQ - oldValue
      );

      // Update in database
      await this.updateQValue(stateKey, action, newValue, reward > 0);

      // Decay exploration rate
      this.config.explorationRate = Math.max(
        this.config.minExploration,
        this.config.explorationRate * this.config.explorationDecay
      );

      // Track total reward
      this.totalReward += reward;
      this.episodeCount++;

      console.log(`[Q-Learning] State: ${stateKey.slice(0, 40)}...`);
      console.log(`[Q-Learning] Action: ${action}, Reward: ${reward.toFixed(2)}`);
      console.log(`[Q-Learning] Q-value: ${oldValue.toFixed(2)} -> ${newValue.toFixed(2)}`);
      console.log(`[Q-Learning] Exploration rate: ${(this.config.explorationRate * 100).toFixed(1)}%`);

    } catch (error) {
      console.error('Error in Q-learning update:', error);
    }
  }

  /**
   * Update Q-value in database
   */
  private async updateQValue(
    stateKey: string,
    action: ActionType,
    newValue: number,
    isWin: boolean
  ): Promise<void> {
    const fieldMap: Record<ActionType, string> = {
      'SKIP': 'skipValue',
      'OPEN_CONSERVATIVE': 'openConservative',
      'OPEN_NORMAL': 'openNormal',
      'OPEN_AGGRESSIVE': 'openAggressive',
      'FUTURES_LOW': 'futuresLow',
      'FUTURES_MEDIUM': 'futuresMedium',
      'FUTURES_HIGH': 'futuresHigh'
    };

    const field = fieldMap[action];

    await prisma.qState.upsert({
      where: { stateKey },
      create: {
        stateKey,
        [field]: newValue,
        visits: 1,
        lastReward: newValue,
        avgReward: newValue,
        winCount: isWin ? 1 : 0,
        lossCount: isWin ? 0 : 1
      },
      update: {
        [field]: newValue,
        visits: { increment: 1 },
        lastReward: newValue,
        winCount: isWin ? { increment: 1 } : undefined,
        lossCount: !isWin ? { increment: 1 } : undefined
      }
    });
  }

  /**
   * Calculate reward from trade result
   */
  calculateReward(result: {
    pnlPct: number;
    exitReason: string;
    leverage: number;
    duration: number; // minutes
  }): number {
    const { pnlPct, exitReason, leverage, duration } = result;

    // Base reward is the PnL percentage
    let reward = pnlPct;

    // Bonus for hitting take profit
    if (exitReason === 'tp' || exitReason === 'TP') {
      reward *= 1.2;
    }

    // Penalty for stop loss
    if (exitReason === 'sl' || exitReason === 'SL') {
      reward *= 1.5; // Amplify negative reward
    }

    // Penalty for liquidation (severe)
    if (exitReason === 'liquidation' || exitReason === 'LIQUIDATION') {
      reward = -100; // Maximum penalty
    }

    // Bonus for quick profitable trades (scalping efficiency)
    if (pnlPct > 0 && duration < 30) {
      reward *= 1.1;
    }

    // Risk-adjusted: Higher leverage success = higher reward
    if (pnlPct > 0 && leverage > 5) {
      reward *= 1 + (leverage - 5) * 0.05;
    }

    return reward;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalReward: number;
    episodeCount: number;
    explorationRate: number;
    avgReward: number;
  } {
    return {
      totalReward: this.totalReward,
      episodeCount: this.episodeCount,
      explorationRate: this.config.explorationRate,
      avgReward: this.episodeCount > 0 ? this.totalReward / this.episodeCount : 0
    };
  }

  /**
   * Initialize with pre-trained values
   */
  async initializePretrainedValues(): Promise<void> {
    console.log('[Q-Learning] Initializing pre-trained Q-values from 87.95% WR IA...');

    for (const [stateKey, qValues] of Object.entries(PRETRAINED_Q_VALUES)) {
      try {
        await prisma.qState.upsert({
          where: { stateKey },
          create: {
            stateKey,
            skipValue: qValues['SKIP'] || 0,
            openConservative: qValues['OPEN_CONSERVATIVE'] || 0,
            openNormal: qValues['OPEN_NORMAL'] || 0,
            openAggressive: qValues['OPEN_AGGRESSIVE'] || 0,
            futuresLow: qValues['FUTURES_LOW'] || 0,
            futuresMedium: qValues['FUTURES_MEDIUM'] || 0,
            futuresHigh: qValues['FUTURES_HIGH'] || 0,
            visits: 10, // Pre-trained states start with some confidence
            avgReward: Math.max(...Object.values(qValues))
          },
          update: {} // Don't overwrite if already exists
        });
      } catch (error) {
        // Ignore duplicate errors
      }
    }

    console.log(`[Q-Learning] Initialized ${Object.keys(PRETRAINED_Q_VALUES).length} pre-trained states`);
  }
}

export const qLearningAgent = new QLearningAgent();
