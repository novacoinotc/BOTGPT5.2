import axios from 'axios';

interface FearGreedData {
  value: number;
  classification: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
  timestamp: number;
}

export class FearGreedIndex {
  private baseUrl = 'https://api.alternative.me/fng/';
  private cache: { data: FearGreedData | null; lastFetch: number } = {
    data: null,
    lastFetch: 0,
  };
  private cacheDuration = 60 * 60 * 1000; // 1 hour cache

  async get(): Promise<FearGreedData> {
    const now = Date.now();

    // Return cached data if fresh
    if (this.cache.data && now - this.cache.lastFetch < this.cacheDuration) {
      return this.cache.data;
    }

    try {
      const response = await axios.get(this.baseUrl);
      const data = response.data.data[0];

      const result: FearGreedData = {
        value: parseInt(data.value),
        classification: this.getClassification(parseInt(data.value)),
        timestamp: parseInt(data.timestamp) * 1000,
      };

      this.cache = { data: result, lastFetch: now };
      return result;
    } catch (error) {
      console.error('[FearGreed] Error fetching index:', error);
      // Return neutral if API fails
      return {
        value: 50,
        classification: 'Neutral',
        timestamp: now,
      };
    }
  }

  private getClassification(value: number): FearGreedData['classification'] {
    if (value <= 20) return 'Extreme Fear';
    if (value <= 40) return 'Fear';
    if (value <= 60) return 'Neutral';
    if (value <= 80) return 'Greed';
    return 'Extreme Greed';
  }

  // Trading signal based on Fear & Greed (contrarian)
  getSignal(value: number): { signal: 'buy' | 'sell' | 'neutral'; strength: number } {
    // Contrarian approach: buy when others are fearful
    if (value <= 25) {
      return { signal: 'buy', strength: (25 - value) / 25 };
    }
    if (value >= 75) {
      return { signal: 'sell', strength: (value - 75) / 25 };
    }
    return { signal: 'neutral', strength: 0 };
  }
}

export const fearGreedIndex = new FearGreedIndex();
