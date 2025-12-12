import { binanceClient } from '../binance/client.js';
import { SMA, EMA, RSI, MACD, BollingerBands, ATR, ADX } from 'technicalindicators';

export interface MarketAnalysis {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  indicators: {
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    ema9: number;
    ema21: number;
    sma50: number;
    bollingerBands: { upper: number; middle: number; lower: number };
    atr: number;
    adx: number;
  };
  orderBook: {
    bidPressure: number;
    askPressure: number;
    imbalance: number; // -1 to 1, positive = more buyers
    spreadPercent: number;
    bigBuyWalls: number[];
    bigSellWalls: number[];
  };
  funding: {
    rate: number;
    sentiment: 'bullish' | 'bearish' | 'neutral';
  };
  regime: 'trending_up' | 'trending_down' | 'ranging' | 'volatile';
  volumeProfile: {
    poc: number; // Point of Control
    valueAreaHigh: number;
    valueAreaLow: number;
  };
}

export class MarketAnalyzer {
  async analyze(symbol: string): Promise<MarketAnalysis> {
    // Fetch all data in parallel
    const [klines, orderBook, ticker, fundingRate] = await Promise.all([
      binanceClient.getKlines(symbol, '15m', 100),
      binanceClient.getOrderBook(symbol, 20),
      binanceClient.get24hrTicker(symbol),
      binanceClient.getFundingRate(symbol),
    ]);

    // Parse OHLCV data
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const highs = klines.map((k: any) => parseFloat(k[2]));
    const lows = klines.map((k: any) => parseFloat(k[3]));
    const volumes = klines.map((k: any) => parseFloat(k[5]));

    // Calculate indicators
    const indicators = this.calculateIndicators(closes, highs, lows);

    // Analyze order book
    const orderBookAnalysis = this.analyzeOrderBook(orderBook, parseFloat(ticker.lastPrice));

    // Analyze funding rate
    const funding = this.analyzeFunding(parseFloat(fundingRate?.fundingRate || '0'));

    // Detect market regime
    const regime = this.detectRegime(closes, indicators);

    // Calculate volume profile
    const volumeProfile = this.calculateVolumeProfile(klines);

    return {
      symbol,
      price: parseFloat(ticker.lastPrice),
      change24h: parseFloat(ticker.priceChangePercent),
      volume24h: parseFloat(ticker.quoteVolume),
      indicators,
      orderBook: orderBookAnalysis,
      funding,
      regime,
      volumeProfile,
    };
  }

  private calculateIndicators(closes: number[], highs: number[], lows: number[]) {
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const macdValues = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const ema9Values = EMA.calculate({ values: closes, period: 9 });
    const ema21Values = EMA.calculate({ values: closes, period: 21 });
    const sma50Values = SMA.calculate({ values: closes, period: 50 });
    const bbValues = BollingerBands.calculate({
      values: closes,
      period: 20,
      stdDev: 2,
    });
    const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const adxValues = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

    const lastMacd = macdValues[macdValues.length - 1] || { MACD: 0, signal: 0, histogram: 0 };
    const lastBB = bbValues[bbValues.length - 1] || { upper: 0, middle: 0, lower: 0 };

    return {
      rsi: rsiValues[rsiValues.length - 1] || 50,
      macd: {
        macd: lastMacd.MACD || 0,
        signal: lastMacd.signal || 0,
        histogram: lastMacd.histogram || 0,
      },
      ema9: ema9Values[ema9Values.length - 1] || closes[closes.length - 1],
      ema21: ema21Values[ema21Values.length - 1] || closes[closes.length - 1],
      sma50: sma50Values[sma50Values.length - 1] || closes[closes.length - 1],
      bollingerBands: {
        upper: lastBB.upper,
        middle: lastBB.middle,
        lower: lastBB.lower,
      },
      atr: atrValues[atrValues.length - 1] || 0,
      adx: adxValues[adxValues.length - 1]?.adx || 0,
    };
  }

  private analyzeOrderBook(
    orderBook: { bids: [string, string][]; asks: [string, string][] },
    currentPrice: number
  ) {
    const bids = orderBook.bids.map(([price, qty]) => ({
      price: parseFloat(price),
      qty: parseFloat(qty),
    }));
    const asks = orderBook.asks.map(([price, qty]) => ({
      price: parseFloat(price),
      qty: parseFloat(qty),
    }));

    const bidVolume = bids.reduce((sum, b) => sum + b.qty * b.price, 0);
    const askVolume = asks.reduce((sum, a) => sum + a.qty * a.price, 0);
    const totalVolume = bidVolume + askVolume;

    const bidPressure = bidVolume / totalVolume;
    const askPressure = askVolume / totalVolume;
    const imbalance = (bidPressure - askPressure) * 2; // Scale to -1 to 1

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const spreadPercent = ((bestAsk - bestBid) / currentPrice) * 100;

    // Find big walls (orders > 2x average)
    const avgBidSize = bidVolume / bids.length;
    const avgAskSize = askVolume / asks.length;

    const bigBuyWalls = bids
      .filter(b => b.qty * b.price > avgBidSize * 2)
      .map(b => b.price);
    const bigSellWalls = asks
      .filter(a => a.qty * a.price > avgAskSize * 2)
      .map(a => a.price);

    return {
      bidPressure,
      askPressure,
      imbalance,
      spreadPercent,
      bigBuyWalls,
      bigSellWalls,
    };
  }

  private analyzeFunding(rate: number): { rate: number; sentiment: 'bullish' | 'bearish' | 'neutral' } {
    // Positive funding = longs pay shorts = market is bullish
    // Negative funding = shorts pay longs = market is bearish
    let sentiment: 'bullish' | 'bearish' | 'neutral';

    if (rate > 0.0001) {
      sentiment = 'bullish';
    } else if (rate < -0.0001) {
      sentiment = 'bearish';
    } else {
      sentiment = 'neutral';
    }

    return { rate, sentiment };
  }

  private detectRegime(
    closes: number[],
    indicators: MarketAnalysis['indicators']
  ): MarketAnalysis['regime'] {
    const { adx, ema9, ema21, bollingerBands } = indicators;
    const currentPrice = closes[closes.length - 1];

    // ADX > 25 indicates trending market
    const isTrending = adx > 25;

    // BB width indicates volatility
    const bbWidth = (bollingerBands.upper - bollingerBands.lower) / bollingerBands.middle;
    const isVolatile = bbWidth > 0.04; // 4% width

    if (isTrending) {
      if (ema9 > ema21 && currentPrice > ema9) {
        return 'trending_up';
      } else if (ema9 < ema21 && currentPrice < ema9) {
        return 'trending_down';
      }
    }

    if (isVolatile) {
      return 'volatile';
    }

    return 'ranging';
  }

  private calculateVolumeProfile(klines: any[]): MarketAnalysis['volumeProfile'] {
    // Simple volume profile calculation
    const priceVolumes: Map<number, number> = new Map();

    for (const k of klines) {
      const avgPrice = (parseFloat(k[2]) + parseFloat(k[3])) / 2; // (high + low) / 2
      const volume = parseFloat(k[5]);
      const roundedPrice = Math.round(avgPrice * 100) / 100; // Round to 2 decimals

      priceVolumes.set(roundedPrice, (priceVolumes.get(roundedPrice) || 0) + volume);
    }

    // Find POC (price with highest volume)
    let poc = 0;
    let maxVolume = 0;
    for (const [price, volume] of priceVolumes) {
      if (volume > maxVolume) {
        maxVolume = volume;
        poc = price;
      }
    }

    // Calculate value area (70% of volume)
    const sortedByVolume = Array.from(priceVolumes.entries()).sort((a, b) => b[1] - a[1]);
    const totalVolume = sortedByVolume.reduce((sum, [, vol]) => sum + vol, 0);
    const valueAreaVolume = totalVolume * 0.7;

    let accumulatedVolume = 0;
    const valueAreaPrices: number[] = [];

    for (const [price, volume] of sortedByVolume) {
      valueAreaPrices.push(price);
      accumulatedVolume += volume;
      if (accumulatedVolume >= valueAreaVolume) break;
    }

    return {
      poc,
      valueAreaHigh: Math.max(...valueAreaPrices),
      valueAreaLow: Math.min(...valueAreaPrices),
    };
  }
}

export const marketAnalyzer = new MarketAnalyzer();
