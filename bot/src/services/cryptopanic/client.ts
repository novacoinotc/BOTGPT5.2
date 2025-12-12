import axios, { AxiosInstance } from 'axios';
import { config } from '../../config/index.js';

// Simple cache to avoid rate limits
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface NewsItem {
  id: number;
  title: string;
  published_at: string;
  url: string;
  source: {
    title: string;
    domain: string;
  };
  currencies?: { code: string; title: string }[];
  votes: {
    positive: number;
    negative: number;
    important: number;
    liked: number;
    disliked: number;
    lol: number;
    toxic: number;
    saved: number;
  };
  kind: 'news' | 'media';
}

interface NewsResponse {
  count: number;
  results: NewsItem[];
}

export class CryptoPanicClient {
  private client: AxiosInstance;
  private cache: Map<string, CacheEntry<NewsItem[]>> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache to avoid rate limits

  constructor() {
    this.client = axios.create({
      baseURL: config.cryptoPanic.baseUrl,
      params: {
        auth_token: config.cryptoPanic.apiKey,
        public: 'true',
      },
    });
  }

  private getCacheKey(options: any): string {
    return JSON.stringify(options);
  }

  private getFromCache(key: string): NewsItem[] | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.CACHE_TTL) {
      return entry.data;
    }
    return null;
  }

  private setCache(key: string, data: NewsItem[]): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getNews(options: {
    currencies?: string[];
    filter?: 'rising' | 'hot' | 'bullish' | 'bearish' | 'important' | 'saved' | 'lol';
    kind?: 'news' | 'media' | 'all';
    limit?: number;
  } = {}): Promise<NewsItem[]> {
    // Check cache first to avoid rate limits
    const cacheKey = this.getCacheKey(options);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log('[CryptoPanic] Using cached news data');
      return options.limit ? cached.slice(0, options.limit) : cached;
    }

    try {
      const params: Record<string, any> = {};

      if (options.currencies?.length) {
        params.currencies = options.currencies.join(',');
      }

      if (options.filter) {
        params.filter = options.filter;
      }

      if (options.kind) {
        params.kind = options.kind;
      }

      const response = await this.client.get<NewsResponse>('/posts/', { params });
      const results = response.data.results || [];

      // Cache the results
      this.setCache(cacheKey, results);

      return options.limit ? results.slice(0, options.limit) : results;
    } catch (error: any) {
      // On rate limit, return empty array and log
      if (error?.response?.status === 429) {
        console.log('[CryptoPanic] Rate limited, using neutral sentiment');
        return [];
      }
      console.error('[CryptoPanic] Error fetching news:', error?.message || error);
      return [];
    }
  }

  async getNewsForSymbol(symbol: string, limit: number = 10): Promise<NewsItem[]> {
    // Convert BTCUSDT to BTC
    const currency = symbol.replace('USDT', '').replace('BUSD', '');
    return this.getNews({ currencies: [currency], limit });
  }

  async getBullishNews(limit: number = 10): Promise<NewsItem[]> {
    return this.getNews({ filter: 'bullish', limit });
  }

  async getBearishNews(limit: number = 10): Promise<NewsItem[]> {
    return this.getNews({ filter: 'bearish', limit });
  }

  async getHotNews(limit: number = 10): Promise<NewsItem[]> {
    return this.getNews({ filter: 'hot', limit });
  }

  async getImportantNews(limit: number = 10): Promise<NewsItem[]> {
    return this.getNews({ filter: 'important', limit });
  }

  // Calculate sentiment score from news
  calculateSentiment(news: NewsItem[]): {
    score: number; // -1 to 1
    bullish: number;
    bearish: number;
    total: number;
  } {
    if (news.length === 0) {
      return { score: 0, bullish: 0, bearish: 0, total: 0 };
    }

    let bullishScore = 0;
    let bearishScore = 0;

    for (const item of news) {
      const { positive, negative, important } = item.votes;
      const weight = 1 + (important * 0.5); // Important news has more weight

      bullishScore += positive * weight;
      bearishScore += negative * weight;
    }

    const total = bullishScore + bearishScore;
    const score = total > 0 ? (bullishScore - bearishScore) / total : 0;

    return {
      score: Math.max(-1, Math.min(1, score)),
      bullish: bullishScore,
      bearish: bearishScore,
      total: news.length,
    };
  }

  // Get news summary for GPT analysis
  async getNewsSummary(symbol: string): Promise<{
    headlines: string[];
    sentiment: { score: number; bullish: number; bearish: number };
    hotTopics: string[];
  }> {
    const [symbolNews, hotNews, bullishNews, bearishNews] = await Promise.all([
      this.getNewsForSymbol(symbol, 5),
      this.getHotNews(3),
      this.getBullishNews(3),
      this.getBearishNews(3),
    ]);

    const allNews = [...symbolNews, ...hotNews];
    const uniqueNews = allNews.filter(
      (item, index, self) => index === self.findIndex(t => t.id === item.id)
    );

    return {
      headlines: uniqueNews.slice(0, 5).map(n => n.title),
      sentiment: this.calculateSentiment(symbolNews),
      hotTopics: hotNews.map(n => n.title),
    };
  }
}

export const cryptoPanicClient = new CryptoPanicClient();
