import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { MarketAnalysis } from '../market/analyzer.js';
import { memorySystem, TradeMemory } from '../memory/index.js';
import { adaptiveLearning, MarketState, ActionType } from '../adaptive/index.js';

export interface GPTDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-100
  reasoning: string;
  entryPrice?: number;
  stopLoss?: number;
  stopLossPercent?: number; // % desde entrada
  takeProfit?: number;
  takeProfitPercent?: number; // % desde entrada
  positionSizePercent: number; // % del capital a usar (1-100)
  leverage: number; // 1-10
  riskLevel: 'low' | 'medium' | 'high';
  timeframe: string;
  patterns: string[];
  marketContext: string;
  // Adaptive Learning fields
  adaptiveAction?: ActionType;
  stateKey?: string;
  qLearningReasoning?: string;
}

interface MarketContext {
  analysis: MarketAnalysis;
  news: {
    headlines: string[];
    sentiment: { score: number };
  };
  fearGreed: {
    value: number;
    classification: string;
  };
  recentTrades: TradeMemory[];
  learnings: string[];
  accountBalance: number;
}

export class GPTEngine {
  private client: OpenAI;
  private screeningModel = 'gpt-5-mini'; // Cheap model for quick screening
  private tradingModel = 'gpt-5.2'; // Premium model for trading decisions

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }

  // STEP 1: Quick screening with cheap model - detects if there's potential opportunity
  async quickScreen(analysis: MarketAnalysis): Promise<{ hasOpportunity: boolean; direction: 'BUY' | 'SELL' | 'NONE'; score: number }> {
    const prompt = `Analiza rápidamente estos indicadores y responde en JSON si hay oportunidad de scalping:

SYMBOL: ${analysis.symbol}
PRECIO: $${analysis.price.toFixed(2)}
RSI: ${analysis.indicators.rsi.toFixed(1)}
MACD Histogram: ${analysis.indicators.macd.histogram > 0 ? 'POSITIVO' : 'NEGATIVO'}
ADX: ${analysis.indicators.adx.toFixed(1)}
Order Book Imbalance: ${(analysis.orderBook.imbalance * 100).toFixed(1)}%
Régimen: ${analysis.regime}
Funding Rate: ${(analysis.funding.rate * 100).toFixed(4)}%

Responde SOLO en JSON:
{"hasOpportunity": true/false, "direction": "BUY"/"SELL"/"NONE", "score": 0-100}

Criterios para oportunidad:
- RSI < 30 o > 70 = señal fuerte
- Imbalance > 20% = presión clara
- ADX > 25 = tendencia
- Score > 50 = vale la pena analizar más`;

    try {
      // Try up to 2 times in case of empty response
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await this.client.chat.completions.create({
          model: this.screeningModel,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_completion_tokens: 900, // Increased - reasoning models need space to think
        });

        const content = response.choices[0]?.message?.content;

        if (!content) {
          if (attempt < 2) {
            console.log(`[GPT-Screen] ${analysis.symbol}: Empty content (attempt ${attempt}), retrying...`);
            continue;
          }
          console.log(`[GPT-Screen] ${analysis.symbol}: Empty content after ${attempt} attempts`);
          return { hasOpportunity: false, direction: 'NONE', score: 0 };
        }

        const result = JSON.parse(content);
        console.log(`[GPT-Screen] ${analysis.symbol}: score=${result.score}, direction=${result.direction}, hasOpp=${result.hasOpportunity}`);

        return {
          hasOpportunity: result.hasOpportunity && result.score >= 60, // COST OPTIMIZED: was 50
          direction: result.direction || 'NONE',
          score: result.score || 0
        };
      }

      return { hasOpportunity: false, direction: 'NONE', score: 0 };
    } catch (error: any) {
      console.error(`[GPT-Screen] ${analysis.symbol} Error:`, error.message || error);
      return { hasOpportunity: false, direction: 'NONE', score: 0 };
    }
  }

  // STEP 2: Full analysis with premium model - only called when screening detects opportunity
  async analyze(context: MarketContext): Promise<GPTDecision> {
    // Get Adaptive Learning recommendation first
    const adaptiveDecision = await this.getAdaptiveRecommendation(context);

    const systemPrompt = this.buildSystemPrompt(context.accountBalance, adaptiveDecision);
    const userPrompt = this.buildAnalysisPrompt(context, adaptiveDecision);

    try {
      // GPT-5.2 with reasoning_effort for optimized performance
      const response = await this.client.chat.completions.create({
        model: this.tradingModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        reasoning_effort: 'low', // 'none'|'low'|'medium'|'high' - low for fast scalping
      } as any);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from GPT');
      }

      const decision = JSON.parse(content) as GPTDecision;

      // Apply adaptive learning recommendations if available
      if (adaptiveDecision.shouldTrade) {
        // Use adaptive leverage and position size as minimums
        decision.leverage = Math.max(decision.leverage || 1, adaptiveDecision.leverage);
        decision.positionSizePercent = Math.max(decision.positionSizePercent || 1, adaptiveDecision.positionSizePct);

        // Use adaptive TP/SL if GPT didn't specify
        if (!decision.takeProfitPercent && adaptiveDecision.tpPct > 0) {
          decision.takeProfitPercent = adaptiveDecision.tpPct;
        }
        if (!decision.stopLossPercent && adaptiveDecision.slPct > 0) {
          decision.stopLossPercent = adaptiveDecision.slPct;
        }
      }

      // Validate and cap values
      decision.leverage = Math.min(Math.max(1, decision.leverage || 3), 15); // Cap at 15x (from IA)
      decision.positionSizePercent = Math.min(Math.max(1, decision.positionSizePercent || 3), 12); // Max 12% (from IA)

      // Add adaptive learning metadata
      decision.adaptiveAction = adaptiveDecision.action;
      decision.stateKey = adaptiveDecision.stateKey;
      decision.qLearningReasoning = adaptiveDecision.reasoning;

      // Store the analysis for learning
      await this.storeAnalysis(context, decision);

      return decision;
    } catch (error) {
      console.error('[GPT] Analysis error:', error);
      return this.getDefaultDecision();
    }
  }

  // Get recommendation from Adaptive Learning System
  private async getAdaptiveRecommendation(context: MarketContext): Promise<{
    shouldTrade: boolean;
    action: ActionType;
    confidence: number;
    leverage: number;
    positionSizePct: number;
    tpPct: number;
    slPct: number;
    stateKey: string;
    reasoning: string;
  }> {
    try {
      const { analysis, fearGreed } = context;

      // Determine signal from analysis
      let signal: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
      if (analysis.orderBook.imbalance > 0.15 && analysis.indicators.rsi < 50) {
        signal = 'BUY';
      } else if (analysis.orderBook.imbalance < -0.15 && analysis.indicators.rsi > 50) {
        signal = 'SELL';
      }

      // Determine regime
      let regime: 'BULL' | 'BEAR' | 'SIDEWAYS' = 'SIDEWAYS';
      let regimeStrength: 'WEAK' | 'MODERATE' | 'STRONG' = 'MODERATE';

      if (analysis.regime === 'trending_up') {
        regime = 'BULL';
        regimeStrength = analysis.indicators.adx > 30 ? 'STRONG' : analysis.indicators.adx > 20 ? 'MODERATE' : 'WEAK';
      } else if (analysis.regime === 'trending_down') {
        regime = 'BEAR';
        regimeStrength = analysis.indicators.adx > 30 ? 'STRONG' : analysis.indicators.adx > 20 ? 'MODERATE' : 'WEAK';
      }

      // Determine orderbook pressure
      let orderbook: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
      if (analysis.orderBook.imbalance > 0.2) orderbook = 'BULLISH';
      else if (analysis.orderBook.imbalance < -0.2) orderbook = 'BEARISH';

      // Calculate volatility percentage
      const volatilityPct = (analysis.indicators.atr / analysis.price) * 100;

      // Build market state
      const marketState: MarketState = {
        symbol: analysis.symbol,
        signal,
        rsi: analysis.indicators.rsi,
        regime,
        regimeStrength,
        orderbook,
        volatility: volatilityPct,
        tradeCount: 0, // Will be set by adaptive system
        fearGreedIndex: fearGreed.value,
        mlSignal: 'NONE',
        sentiment: 'NEUTRAL'
      };

      // Get adaptive decision
      const decision = await adaptiveLearning.getDecision(marketState, 50);

      console.log(`[Adaptive] ${analysis.symbol}: Action=${decision.action} | Confidence=${decision.confidence}% | ${decision.reasoning}`);

      return {
        shouldTrade: decision.shouldTrade,
        action: decision.action,
        confidence: decision.confidence,
        leverage: decision.leverage,
        positionSizePct: decision.positionSizePct,
        tpPct: decision.tpPct,
        slPct: decision.slPct,
        stateKey: decision.stateKey,
        reasoning: decision.reasoning
      };
    } catch (error) {
      console.error('[Adaptive] Error getting recommendation:', error);
      return {
        shouldTrade: false,
        action: 'SKIP',
        confidence: 0,
        leverage: 1,
        positionSizePct: 0,
        tpPct: 0,
        slPct: 0,
        stateKey: '',
        reasoning: 'Error en sistema adaptativo'
      };
    }
  }

  private buildSystemPrompt(accountBalance: number, adaptiveRec?: {
    shouldTrade: boolean;
    action: ActionType;
    confidence: number;
    leverage: number;
    positionSizePct: number;
    tpPct: number;
    slPct: number;
    reasoning: string;
  }): string {
    // Build adaptive recommendation section if available
    const adaptiveSection = adaptiveRec ? `
=== 🤖 RECOMENDACIÓN DEL SISTEMA ADAPTATIVO (IA con 87.95% WR) ===
${adaptiveRec.shouldTrade ? `✅ SEÑAL DETECTADA: ${adaptiveRec.action}
📊 Confianza Q-Learning: ${adaptiveRec.confidence.toFixed(0)}%
💪 Leverage sugerido: ${adaptiveRec.leverage}x
📏 Posición sugerida: ${adaptiveRec.positionSizePct.toFixed(1)}%
🎯 TP sugerido: ${adaptiveRec.tpPct.toFixed(2)}%
🛡️ SL sugerido: ${adaptiveRec.slPct.toFixed(2)}%
💡 Razón: ${adaptiveRec.reasoning}

⚠️ IMPORTANTE: El sistema adaptativo ha identificado un patrón PROBADO con alta probabilidad.
Considera seguir esta recomendación si el análisis técnico lo confirma.` : `⏸️ Sin señal clara - Sistema recomienda ESPERAR
💡 Razón: ${adaptiveRec.reasoning}`}
` : '';

    return `Eres un TRADER PROFESIONAL de élite con un SISTEMA ADAPTATIVO que aprende de cada trade.

💰 CAPITAL: $${accountBalance.toFixed(2)} USDT
${adaptiveSection}
=== TU MISIÓN ===
🎯 Lograr WIN RATE > 65% siendo selectivo y preciso
🎯 Maximizar Take Profit en cada trade
🎯 Aprender y mejorar con cada operación
🎯 Seguir las señales del sistema adaptativo cuando sean fuertes

=== PATRONES GANADORES DEL Q-LEARNING (87.95% win rate) ===

📊 TOP ESTADOS RENTABLES:
1. SELL + BEAR_MODERATE/STRONG + LOW_RSI + EXTREME_FEAR → FUTURES_HIGH (valor Q: 74+)
2. SELL + BEAR_STRONG + VERY_HIGH_VOL + EXTREME_FEAR → Oportunidad SHORT
3. Tendencia FUERTE (ADX > 25) + Fear & Greed EXTREMO = Alta probabilidad
4. RSI < 30 en mercado BEAR = SHORT con confianza
5. RSI > 70 en mercado BEAR = Precaución, posible trampa

📊 ACCIONES DISPONIBLES:
- SKIP: No operar (mercado confuso o sin señal)
- OPEN_CONSERVATIVE: Posición pequeña, 1x leverage
- OPEN_NORMAL: Posición estándar, 1x leverage
- OPEN_AGGRESSIVE: Posición grande, 1x leverage
- FUTURES_LOW: 5x leverage (conservador)
- FUTURES_MEDIUM: 6x leverage (balanceado)
- FUTURES_HIGH: 10-14x leverage (agresivo)

📊 CUÁNDO SEGUIR AL SISTEMA ADAPTATIVO:
- Si recomienda FUTURES_HIGH con confianza > 70% → SEGUIR
- Si recomienda SKIP → Probablemente HOLD
- Si hay conflicto con tu análisis → Usa tu criterio pero considera la experiencia del sistema

=== PARÁMETROS ÓPTIMOS (de 236 trials) ===
- RSI Oversold: 26 | RSI Overbought: 74
- Min Confianza: 55% | Min Confianza Futuros: 75%
- Leverage Conservador: 5x | Balanceado: 6x | Agresivo: 14x
- Fear & Greed Extremo: ≤24 (OPORTUNIDAD SHORT)

=== COSTOS A CONSIDERAR ===
💸 API: ~$0.03 por análisis
💸 Comisión: 0.10% round trip
⚠️ Solo entra si ganancia esperada > costos

=== RESPUESTA JSON ===
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reasoning": "Tu análisis + razón de seguir/ignorar sistema adaptativo",
  "entryPrice": precio,
  "stopLoss": precio_sl,
  "stopLossPercent": porcentaje,
  "takeProfit": precio_tp,
  "takeProfitPercent": porcentaje,
  "positionSizePercent": 1-12,
  "leverage": 1-15,
  "riskLevel": "low" | "medium" | "high",
  "timeframe": "1m" | "5m" | "15m",
  "patterns": ["patrón"],
  "marketContext": "Resumen del mercado"
}`;
  }

  private buildAnalysisPrompt(context: MarketContext, adaptiveRec?: {
    shouldTrade: boolean;
    action: ActionType;
    stateKey: string;
  }): string {
    const { analysis, news, fearGreed, recentTrades, learnings } = context;

    // Calculate statistics from recent trades
    const wins = recentTrades.filter(t => t.pnl > 0).length;
    const losses = recentTrades.filter(t => t.pnl < 0).length;
    const winRate = recentTrades.length > 0 ? (wins / recentTrades.length) * 100 : 0;
    const avgWin = wins > 0
      ? recentTrades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / wins
      : 0;
    const avgLoss = losses > 0
      ? Math.abs(recentTrades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0) / losses)
      : 0;
    const consecutiveLosses = this.countConsecutiveLosses(recentTrades);

    // Calculate suggested SL/TP based on ATR
    const atrMultiplierSL = analysis.regime === 'volatile' ? 2 : 1.5;
    const atrMultiplierTP = analysis.regime === 'trending_up' || analysis.regime === 'trending_down' ? 2.5 : 1.5;
    const suggestedSL = analysis.indicators.atr * atrMultiplierSL;
    const suggestedTP = analysis.indicators.atr * atrMultiplierTP;

    return `
═══════════════════════════════════════════════════════
ANÁLISIS DE MERCADO: ${analysis.symbol}
Timestamp: ${new Date().toISOString()}
═══════════════════════════════════════════════════════

📊 PRECIO Y VOLUMEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Precio actual: $${analysis.price.toFixed(2)}
Cambio 24h: ${analysis.change24h >= 0 ? '+' : ''}${analysis.change24h.toFixed(2)}%
Volumen 24h: $${(analysis.volume24h / 1000000).toFixed(2)}M

📈 INDICADORES TÉCNICOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RSI(14): ${analysis.indicators.rsi.toFixed(1)} ${analysis.indicators.rsi > 70 ? '⚠️ SOBRECOMPRA' : analysis.indicators.rsi < 30 ? '⚠️ SOBREVENTA' : '✓ NEUTRAL'}

MACD:
  - Histograma: ${analysis.indicators.macd.histogram.toFixed(4)} ${analysis.indicators.macd.histogram > 0 ? '🟢 ALCISTA' : '🔴 BAJISTA'}
  - MACD Line: ${analysis.indicators.macd.macd.toFixed(4)}
  - Signal: ${analysis.indicators.macd.signal.toFixed(4)}
  - Cruce: ${Math.abs(analysis.indicators.macd.macd - analysis.indicators.macd.signal) < 0.001 ? '⚡ INMINENTE' : 'No'}

EMAs y SMAs:
  - EMA9: $${analysis.indicators.ema9.toFixed(2)} ${analysis.price > analysis.indicators.ema9 ? '(precio ARRIBA ✓)' : '(precio ABAJO ✗)'}
  - EMA21: $${analysis.indicators.ema21.toFixed(2)} ${analysis.price > analysis.indicators.ema21 ? '(precio ARRIBA ✓)' : '(precio ABAJO ✗)'}
  - SMA50: $${analysis.indicators.sma50.toFixed(2)} ${analysis.price > analysis.indicators.sma50 ? '(precio ARRIBA ✓)' : '(precio ABAJO ✗)'}
  - Alineación: ${analysis.indicators.ema9 > analysis.indicators.ema21 && analysis.indicators.ema21 > analysis.indicators.sma50 ? '🟢 ALCISTA PERFECTA' : analysis.indicators.ema9 < analysis.indicators.ema21 && analysis.indicators.ema21 < analysis.indicators.sma50 ? '🔴 BAJISTA PERFECTA' : '🟡 MIXTA'}

Bollinger Bands:
  - Upper: $${analysis.indicators.bollingerBands.upper.toFixed(2)}
  - Middle: $${analysis.indicators.bollingerBands.middle.toFixed(2)}
  - Lower: $${analysis.indicators.bollingerBands.lower.toFixed(2)}
  - Posición precio: ${analysis.price > analysis.indicators.bollingerBands.upper ? '⚠️ SOBRE UPPER' : analysis.price < analysis.indicators.bollingerBands.lower ? '⚠️ BAJO LOWER' : '✓ DENTRO'}
  - BB Width: ${(((analysis.indicators.bollingerBands.upper - analysis.indicators.bollingerBands.lower) / analysis.indicators.bollingerBands.middle) * 100).toFixed(2)}%

Volatilidad:
  - ATR(14): $${analysis.indicators.atr.toFixed(2)} (${((analysis.indicators.atr / analysis.price) * 100).toFixed(3)}% del precio)
  - ADX: ${analysis.indicators.adx.toFixed(1)} ${analysis.indicators.adx > 25 ? '💪 TENDENCIA FUERTE' : '😴 RANGO/DÉBIL'}

📚 ORDER BOOK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Presión compradora: ${(analysis.orderBook.bidPressure * 100).toFixed(1)}%
Presión vendedora: ${(analysis.orderBook.askPressure * 100).toFixed(1)}%
IMBALANCE: ${(analysis.orderBook.imbalance * 100).toFixed(1)}% ${analysis.orderBook.imbalance > 0.2 ? '🟢 COMPRADORES DOMINAN' : analysis.orderBook.imbalance < -0.2 ? '🔴 VENDEDORES DOMINAN' : '🟡 EQUILIBRADO'}
Spread: ${analysis.orderBook.spreadPercent.toFixed(4)}% ${analysis.orderBook.spreadPercent > 0.03 ? '⚠️ SPREAD ALTO' : '✓ OK'}
Muros de compra: ${analysis.orderBook.bigBuyWalls.slice(0, 3).map(p => '$' + p.toFixed(2)).join(', ') || 'ninguno'}
Muros de venta: ${analysis.orderBook.bigSellWalls.slice(0, 3).map(p => '$' + p.toFixed(2)).join(', ') || 'ninguno'}

💰 FUNDING RATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Rate: ${(analysis.funding.rate * 100).toFixed(4)}%
Sentimiento: ${analysis.funding.sentiment === 'bullish' ? '🟢 ALCISTA (longs pagan)' : analysis.funding.sentiment === 'bearish' ? '🔴 BAJISTA (shorts pagan)' : '🟡 NEUTRAL'}
${Math.abs(analysis.funding.rate) > 0.0005 ? '⚠️ FUNDING EXTREMO - posible reversión' : ''}

🎯 RÉGIMEN DE MERCADO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${analysis.regime === 'trending_up' ? '📈 TENDENCIA ALCISTA' :
  analysis.regime === 'trending_down' ? '📉 TENDENCIA BAJISTA' :
  analysis.regime === 'volatile' ? '🌪️ ALTA VOLATILIDAD' : '↔️ RANGO/LATERAL'}

📍 VOLUME PROFILE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POC (Point of Control): $${analysis.volumeProfile.poc.toFixed(2)} ${Math.abs(analysis.price - analysis.volumeProfile.poc) / analysis.price < 0.005 ? '⚡ PRECIO EN POC' : ''}
Value Area High: $${analysis.volumeProfile.valueAreaHigh.toFixed(2)}
Value Area Low: $${analysis.volumeProfile.valueAreaLow.toFixed(2)}

📰 NOTICIAS Y SENTIMIENTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Fear & Greed Index: ${fearGreed.value} - ${fearGreed.classification} ${fearGreed.value <= 25 ? '😱 MIEDO EXTREMO (contrarian: comprar?)' : fearGreed.value >= 75 ? '🤑 CODICIA EXTREMA (contrarian: vender?)' : ''}
Sentimiento noticias: ${(news.sentiment.score * 100).toFixed(0)}% ${news.sentiment.score > 0.3 ? '🟢' : news.sentiment.score < -0.3 ? '🔴' : '🟡'}
Headlines:
${news.headlines.slice(0, 5).map(h => `  • ${h}`).join('\n') || '  • Sin noticias recientes'}

📊 TU HISTORIAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trades: ${recentTrades.length} | Win Rate: ${winRate.toFixed(1)}% | Avg Win: +${avgWin.toFixed(2)}% | Avg Loss: -${avgLoss.toFixed(2)}%

📈 ÚLTIMOS TRADES:
${recentTrades.slice(0, 15).map(t =>
  `  ${t.pnl > 0 ? '✅' : '❌'} ${t.symbol} ${t.side} ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}% ($${t.pnlUsd.toFixed(2)}) [${t.exitReason}]`
).join('\n') || '  Sin trades aún - construye tu historial'}

🧠 LECCIONES APRENDIDAS:
${learnings.slice(0, 8).map(l => `• ${l}`).join('\n') || '• Cada trade es una oportunidad de aprender'}

💡 REFERENCIA ATR:
SL por volatilidad: ~${((suggestedSL / analysis.price) * 100).toFixed(2)}% | TP: ~${((suggestedTP / analysis.price) * 100).toFixed(2)}%

═══════════════════════════════════════════════════════
🎯 TU DECISIÓN
═══════════════════════════════════════════════════════

Como trader profesional, analiza todo lo anterior y decide:
- ¿Ves una oportunidad clara? → BUY o SELL con convicción
- ¿El mercado está confuso? → HOLD y espera mejor momento

Confío en tu criterio. Toma la decisión que consideres correcta.
`;
  }

  private countConsecutiveLosses(trades: TradeMemory[]): number {
    let count = 0;
    for (const trade of trades) {
      if (trade.pnl < 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private async storeAnalysis(context: MarketContext, decision: GPTDecision): Promise<void> {
    // Store for pattern learning - now with lower threshold
    if (decision.action !== 'HOLD' && decision.confidence >= 40) {
      await memorySystem.storePattern({
        symbol: context.analysis.symbol,
        pattern: decision.patterns.join(', '),
        regime: context.analysis.regime,
        indicators: {
          rsi: context.analysis.indicators.rsi,
          macdHistogram: context.analysis.indicators.macd.histogram,
          orderBookImbalance: context.analysis.orderBook.imbalance,
          fundingRate: context.analysis.funding.rate,
        },
        decision: decision.action,
        confidence: decision.confidence,
        timestamp: Date.now(),
      });
    }
  }

  private getDefaultDecision(): GPTDecision {
    return {
      action: 'HOLD',
      confidence: 0,
      reasoning: 'Error en análisis, mantener posición por seguridad',
      positionSizePercent: 0,
      leverage: 1,
      riskLevel: 'high',
      timeframe: '5m',
      patterns: [],
      marketContext: 'Error - sin análisis disponible',
    };
  }

  // Learn from completed trade
  async learnFromTrade(trade: TradeMemory): Promise<string> {
    const prompt = `
Analiza este trade completado y extrae UNA lección aprendida importante:

═══════════════════════════════════════════
TRADE COMPLETADO
═══════════════════════════════════════════
Par: ${trade.symbol}
Dirección: ${trade.side}
Entrada: $${trade.entryPrice.toFixed(2)}
Salida: $${trade.exitPrice.toFixed(2)}
PnL: ${trade.pnl > 0 ? '+' : ''}${trade.pnl.toFixed(2)}%
PnL USD: $${trade.pnlUsd.toFixed(2)}
Razón de cierre: ${trade.exitReason}
Duración: ${((trade.exitTime - trade.entryTime) / 60000).toFixed(1)} minutos
Confianza GPT: ${trade.gptConfidence}%

Condiciones de entrada:
- RSI: ${trade.entryConditions.rsi?.toFixed(1) || 'N/A'}
- Régimen: ${trade.entryConditions.regime || 'N/A'}
- Fear & Greed: ${trade.entryConditions.fearGreed || 'N/A'}
- Order Book Imbalance: ${((trade.entryConditions.orderBookImbalance || 0) * 100).toFixed(1)}%
═══════════════════════════════════════════

${trade.pnl > 0
  ? 'El trade fue GANADOR. ¿Qué hicimos bien? ¿Podríamos haber capturado más profit?'
  : 'El trade fue PERDEDOR. ¿Qué señales ignoramos? ¿Qué haremos diferente?'}

Responde con UNA sola lección concisa y accionable (máximo 150 caracteres).
Formato: "En [condición], [acción a tomar]"
Ejemplo: "En RSI>70 con funding alto, esperar confirmación de reversión antes de shortear"
`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.screeningModel, // Use cheap model for learning extraction
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: 500, // Reasoning models need more tokens
      });

      const lesson = response.choices[0]?.message?.content?.trim() || '';

      if (lesson) {
        // Store the learning
        await memorySystem.storeLearning(lesson, trade.pnl > 0 ? 'success' : 'failure', {
          symbol: trade.symbol,
          pnl: trade.pnl,
          regime: trade.entryConditions.regime,
          rsi: trade.entryConditions.rsi,
          confidence: trade.gptConfidence,
        });
      }

      return lesson;
    } catch (error) {
      console.error('[GPT] Learning error:', error);
      return '';
    }
  }
}

export const gptEngine = new GPTEngine();
