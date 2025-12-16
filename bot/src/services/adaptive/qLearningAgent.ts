/**
 * Q-Learning Agent - Learns optimal actions from trade outcomes
 * Based on the 87.95% win rate IA architecture
 */

import { PrismaClient } from '@prisma/client';
import { stateEncoder, MarketState, ActionType } from './stateEncoder';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

// Q-table loaded from the IA training data
let PRETRAINED_Q_VALUES: Record<string, Record<string, number>> = {};

// Load Q-table from JSON file
function loadQTableFromFile(): void {
  try {
    // Try multiple possible paths (with and without spaces in filename)
    const possiblePaths = [
      path.join(process.cwd(), 'IA_200_TRADES.json'),
      path.join(process.cwd(), 'IA 200 TRADES.json'),
      path.join(process.cwd(), '..', 'IA 200 TRADES.json'),
      path.join(__dirname, '..', '..', '..', 'IA_200_TRADES.json'),
      path.join(__dirname, '..', '..', '..', '..', 'IA 200 TRADES.json'),
    ];

    let jsonData: any = null;
    let loadedPath = '';

    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        let fileContent = fs.readFileSync(filePath, 'utf-8');
        // Fix invalid JSON values (Infinity, NaN, -Infinity)
        fileContent = fileContent
          .replace(/:\s*Infinity/g, ': 999999')
          .replace(/:\s*-Infinity/g, ': -999999')
          .replace(/:\s*NaN/g, ': 0');
        jsonData = JSON.parse(fileContent);
        loadedPath = filePath;
        break;
      }
    }

    if (jsonData && jsonData.rl_agent && jsonData.rl_agent.q_table) {
      const qTable = jsonData.rl_agent.q_table;
      let stateCount = 0;
      let actionCount = 0;

      for (const [stateKey, actions] of Object.entries(qTable)) {
        if (typeof actions === 'object' && actions !== null && Object.keys(actions).length > 0) {
          PRETRAINED_Q_VALUES[stateKey] = actions as Record<string, number>;
          stateCount++;
          actionCount += Object.keys(actions).length;
        }
      }

      console.log(`[Q-Learning] ✅ Loaded Q-table from ${loadedPath}`);
      console.log(`[Q-Learning] ✅ ${stateCount} states with ${actionCount} action values`);
    } else {
      console.log('[Q-Learning] ⚠️ No Q-table found in JSON, using empty table');
    }
  } catch (error) {
    console.error('[Q-Learning] ❌ Error loading Q-table from file:', error);
  }
}

// Load Q-table on module initialization
loadQTableFromFile();

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
   * Get Q-values for a state from database or pre-trained data
   */
  async getQValues(stateKey: string): Promise<Record<ActionType, number>> {
    // Default zero values
    const defaultValues: Record<ActionType, number> = {
      'SKIP': 0,
      'OPEN_CONSERVATIVE': 0,
      'OPEN_NORMAL': 0,
      'OPEN_AGGRESSIVE': 0,
      'FUTURES_LOW': 0,
      'FUTURES_MEDIUM': 0,
      'FUTURES_HIGH': 0
    };

    try {
      // First check database for learned values
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

      // Check pre-trained values (exact match)
      if (PRETRAINED_Q_VALUES[stateKey]) {
        const pretrainedValues = PRETRAINED_Q_VALUES[stateKey];
        return {
          ...defaultValues,
          ...pretrainedValues
        } as Record<ActionType, number>;
      }

      // Try fuzzy match: same symbol + signal + regime, ignore other factors
      const fuzzyMatch = this.findFuzzyMatch(stateKey);
      if (fuzzyMatch) {
        return {
          ...defaultValues,
          ...fuzzyMatch
        } as Record<ActionType, number>;
      }

      return defaultValues;
    } catch (error) {
      console.error('Error getting Q-values:', error);

      // Fallback to pre-trained on error
      if (PRETRAINED_Q_VALUES[stateKey]) {
        return {
          ...defaultValues,
          ...PRETRAINED_Q_VALUES[stateKey]
        } as Record<ActionType, number>;
      }

      return defaultValues;
    }
  }

  /**
   * Find a fuzzy match in the Q-table based on key components
   */
  private findFuzzyMatch(stateKey: string): Record<string, number> | null {
    const parts = stateKey.split('_');
    if (parts.length < 4) return null;

    // Extract key components: SYMBOL_SIGNAL_RSI_REGIME
    const symbol = parts[0]; // e.g., "BTC/USDT"
    const signal = parts[1]; // e.g., "SELL"
    const regime = parts[3]; // e.g., "BEAR"

    let bestMatch: Record<string, number> | null = null;
    let bestScore = 0;

    for (const [key, values] of Object.entries(PRETRAINED_Q_VALUES)) {
      const keyParts = key.split('_');
      if (keyParts.length < 4) continue;

      let score = 0;

      // Symbol match (most important)
      if (keyParts[0] === symbol) score += 10;

      // Signal match (very important)
      if (keyParts[1] === signal) score += 5;

      // Regime match
      if (keyParts[3] === regime) score += 3;

      // RSI zone match
      if (keyParts[2] === parts[2]) score += 2;

      // Regime strength match
      if (keyParts[4] === parts[4]) score += 1;

      // Only consider matches with symbol + signal
      if (score >= 15 && score > bestScore) {
        bestScore = score;
        bestMatch = values;
      }
    }

    if (bestMatch) {
      console.log(`[Q-Learning] Fuzzy match found for ${stateKey.slice(0, 30)}... (score: ${bestScore})`);
    }

    return bestMatch;
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

    // Calculate confidence based on Q-value magnitude, spread, and if we have data
    const qValuesArray = Object.values(qValues);
    const maxQ = Math.max(...qValuesArray);
    const sumQ = qValuesArray.reduce((a, b) => a + b, 0);
    const nonZeroCount = qValuesArray.filter(v => v > 0).length;

    // If all Q-values are 0, we have NO data for this state = very low confidence
    if (sumQ === 0) {
      // No pre-trained data for this state - low confidence
      return {
        action: 'SKIP' as ActionType, // Default to SKIP when no data
        confidence: 20, // Very low confidence
        isExploration: true,
        stateKey,
        qValues
      };
    }

    // Calculate confidence based on:
    // 1. How high is the best Q-value (higher = more certain from experience)
    // 2. How much spread between best and others (more spread = clearer winner)
    const sortedQ = [...qValuesArray].sort((a, b) => b - a);
    const spread = sortedQ[0] - sortedQ[1]; // Difference between 1st and 2nd best

    // Confidence formula:
    // - Base: maxQ contributes up to 60% (capped at maxQ=50 -> 60%)
    // - Spread: adds up to 30% for clear winners
    // - Min 30% if we have some data
    const baseConfidence = Math.min(60, maxQ * 1.2);
    const spreadBonus = Math.min(30, spread * 2);
    const confidence = Math.min(95, Math.max(30, baseConfidence + spreadBonus));

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
