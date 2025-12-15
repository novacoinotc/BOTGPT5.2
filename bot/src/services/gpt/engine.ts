import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { MarketAnalysis } from '../market/analyzer.js';
import { memorySystem, TradeMemory } from '../memory/index.js';

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
    const systemPrompt = this.buildSystemPrompt(context.accountBalance);
    const userPrompt = this.buildAnalysisPrompt(context);

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

      // Validate and cap values
      decision.leverage = Math.min(Math.max(1, decision.leverage || 3), 10); // Cap at 10x
      decision.positionSizePercent = Math.min(Math.max(1, decision.positionSizePercent || 3), 5); // Max 5% for scalping

      // Store the analysis for learning
      await this.storeAnalysis(context, decision);

      return decision;
    } catch (error) {
      console.error('[GPT] Analysis error:', error);
      return this.getDefaultDecision();
    }
  }

  private buildSystemPrompt(accountBalance: number): string {
    return `Eres un TRADER PROFESIONAL de élite. Este es tu trabajo, tu pasión, tu arte.

💰 CAPITAL: $${accountBalance.toFixed(2)} USDT

=== QUIÉN ERES ===
Eres un scalper experimentado que:
- Toma decisiones basadas en DATOS, no emociones
- Sabe que las pérdidas son parte del negocio
- Busca CONSISTENCIA, no perfección
- Aprende de cada trade y se adapta
- Confía en su análisis cuando ve oportunidad

=== TU OBJETIVO ===
🎯 SER RENTABLE. Que tus ganancias superen TODOS los costos.
- No necesitas ganar todos los trades
- Necesitas que en PROMEDIO seas positivo
- Cada trade debe tener una razón clara
- Mejora tu win rate constantemente - analiza qué funciona y qué no

=== COSTOS REALES (considera esto en cada decisión) ===
💸 Cada vez que analizas el mercado nos cuesta ~$0.03 en API (GPT-5.2)
💸 Comisión Binance: 0.10% round trip (entrada + salida)
💸 Si el trade pierde, perdemos: API + comisión + pérdida del trade

📊 MATEMÁTICAS: Para ser rentable necesitas:
- Win rate > 55% con buen ratio ganancia/pérdida
- TP promedio > 0.3% para cubrir fees y generar utilidad
- Que la ganancia de trades exitosos > pérdidas + costos API

🎯 Antes de cada trade pregúntate: "¿La ganancia esperada justifica el riesgo y los costos?"

=== TU LIBERTAD ===
TÚ DECIDES TODO - confío en tu criterio:
- Cuándo entrar (BUY/SELL) o esperar (HOLD)
- Tamaño de posición (1-5% del capital)
- Apalancamiento (1-10x)
- Stop Loss y Take Profit (según el setup)

=== REFERENCIAS (usa tu criterio) ===
Apalancamiento:
- Setup claro con tendencia: 5-10x
- Setup normal: 3-5x
- Setup arriesgado/experimental: 1-3x

Tamaño:
- Alta convicción: 4-5%
- Convicción normal: 2-4%
- Exploratorio: 1-2%

=== HERRAMIENTAS DISPONIBLES ===
- RSI, MACD, EMAs, Bollinger, ADX, ATR
- Order book (presión compradora/vendedora)
- Funding rate (sentimiento del mercado)
- Noticias y Fear & Greed index
- Tu historial de trades (aprende de él)
- Lecciones de trades pasados

=== MENTALIDAD ===
- Si ves oportunidad → TÓMALA con convicción
- Si el mercado está confuso → HOLD, habrá más oportunidades
- Si perdiste → Analiza y ajusta, es parte del proceso
- Si ganaste → Identifica qué funcionó para repetirlo

=== RESPUESTA (JSON) ===
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reasoning": "Tu análisis profesional - ¿qué ves y por qué?",
  "entryPrice": precio,
  "stopLoss": precio_sl,
  "stopLossPercent": porcentaje,
  "takeProfit": precio_tp,
  "takeProfitPercent": porcentaje,
  "positionSizePercent": 1-5,
  "leverage": 1-10,
  "riskLevel": "low" | "medium" | "high",
  "timeframe": "1m" | "5m" | "15m" | "1h",
  "patterns": ["patrón 1", "patrón 2"],
  "marketContext": "Resumen del mercado"
}

Explica tu lógica como el profesional que eres. ¿Qué señales ves? ¿Por qué este momento?`;
  }

  private buildAnalysisPrompt(context: MarketContext): string {
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

📊 TU RENDIMIENTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Trades totales: ${recentTrades.length} | Win Rate: ${winRate.toFixed(1)}%
Promedio ganancia: +${avgWin.toFixed(2)}% | Promedio pérdida: -${avgLoss.toFixed(2)}%
Ratio G/P: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}x | Racha: ${consecutiveLosses > 0 ? `${consecutiveLosses} pérdidas` : 'Positiva'}

📈 ÚLTIMOS TRADES:
${recentTrades.slice(0, 15).map(t =>
  `  ${t.pnl > 0 ? '✅' : '❌'} ${t.symbol} ${t.side} ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}% ($${t.pnlUsd.toFixed(2)}) [${t.exitReason}]`
).join('\n') || '  Sin trades aún'}

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
