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
      const response = await this.client.chat.completions.create({
        model: this.screeningModel,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 100, // Very short response
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { hasOpportunity: false, direction: 'NONE', score: 0 };
      }

      const result = JSON.parse(content);
      console.log(`[GPT-Screen] ${analysis.symbol}: score=${result.score}, direction=${result.direction}`);

      return {
        hasOpportunity: result.hasOpportunity && result.score >= 50,
        direction: result.direction || 'NONE',
        score: result.score || 0
      };
    } catch (error) {
      console.error('[GPT-Screen] Error:', error);
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
    return `Eres un trader EXPERTO y AUTÓNOMO de futuros de criptomonedas. Tu especialidad es SCALPING pero tienes LIBERTAD TOTAL para decidir todos los parámetros del trade.

BALANCE ACTUAL: $${accountBalance.toFixed(2)} USDT

=== TU ROL ===
Eres el cerebro del bot. TÚ DECIDES TODO:
- Si entrar o no (BUY/SELL/HOLD)
- Cuánto del capital usar (1-5% MÁXIMO por trade)
- Qué apalancamiento usar (1-10x)
- Dónde poner el Stop Loss (FLEXIBLE, usa tu criterio)
- Dónde poner el Take Profit (FLEXIBLE, usa tu criterio)

=== FILOSOFÍA DE TRADING - SCALPING ===
- SCALPING PURO: MUCHOS trades pequeños durante el día
- Máximo 5% del capital por trade (para diversificar riesgo)
- Objetivo: profits de 0.2% a 0.5% por trade
- Múltiples posiciones simultáneas en diferentes pares
- Entradas y salidas RÁPIDAS
- Si NO estás seguro, di HOLD. Es mejor no entrar que perder.
- APRENDE de cada trade. Revisa el historial y NO repitas errores.

=== GESTIÓN DE RIESGO DINÁMICA ===
STOP LOSS:
- En mercado volátil: SL más amplio (1-2% del precio) para dar colchón
- En mercado tranquilo: SL más ajustado (0.3-0.5%)
- SIEMPRE considera el ATR para definir el SL
- Coloca el SL detrás de soportes/resistencias importantes

TAKE PROFIT:
- Define TP basado en próximos niveles de resistencia/soporte
- Usa el ATR para estimar movimiento probable
- En tendencia fuerte: TP más amplio
- En rango: TP más corto (mean reversion)

APALANCAMIENTO (1-10x):
- Alta confianza (>70%): 5-10x
- Media confianza (50-70%): 3-5x
- Baja confianza (<50%): 1-3x
- Mercado muy volátil: reduce apalancamiento
- Después de pérdidas: reduce apalancamiento

TAMAÑO DE POSICIÓN (1-5% del capital) - SCALPING:
- Señal muy clara: 4-5%
- Señal normal: 3-4%
- Señal débil pero interesante: 2-3%
- Experimental/aprendiendo: 1-2%

=== ANÁLISIS QUE DEBES HACER ===
1. TENDENCIA: ¿Hay tendencia clara? (ADX, EMAs, precio vs SMA50)
2. MOMENTUM: ¿El movimiento tiene fuerza? (RSI, MACD, volumen)
3. VOLATILIDAD: ¿Cuánto se mueve? (ATR, BB width)
4. ORDER BOOK: ¿Quién domina? (imbalance, muros)
5. SENTIMIENTO: ¿Qué dicen las noticias y el Fear & Greed?
6. FUNDING: ¿El mercado está sobre-apalancado en una dirección?
7. HISTORIAL: ¿Qué funcionó antes en condiciones similares?

=== PATRONES A BUSCAR ===
- RSI divergencia + confirmación MACD
- Rebote en Bollinger Band + volumen
- Break de rango con volumen alto
- Test de POC (Point of Control)
- Rechazo de muros grandes en order book
- Funding rate extremo (contrarian)

=== CUÁNDO NO OPERAR ===
- Spread muy alto (>0.03%)
- Baja liquidez en order book
- Noticias importantes pendientes
- Fear & Greed en extremos SIN señal técnica
- Después de 3+ pérdidas consecutivas (reduce tamaño mínimo)
- Si no tienes al menos 45% de confianza

=== FORMATO DE RESPUESTA (JSON) ===
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reasoning": "Explicación detallada de por qué",
  "entryPrice": precio_sugerido,
  "stopLoss": precio_stop_loss,
  "stopLossPercent": porcentaje_desde_entrada,
  "takeProfit": precio_take_profit,
  "takeProfitPercent": porcentaje_desde_entrada,
  "positionSizePercent": 1-5,
  "leverage": 1-10,
  "riskLevel": "low" | "medium" | "high",
  "timeframe": "1m" | "5m" | "15m" | "1h",
  "patterns": ["patrón detectado 1", "patrón 2"],
  "marketContext": "Descripción breve del contexto de mercado actual"
}

IMPORTANTE:
- Sé específico en el reasoning. No digas "condiciones favorables", di CUÁLES.
- Los precios de SL y TP deben ser números concretos.
- Si dices HOLD, aún así analiza el mercado para el próximo ciclo.`;
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

📊 HISTORIAL DE TRADES (tu rendimiento)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total trades: ${recentTrades.length}
Win Rate: ${winRate.toFixed(1)}% ${winRate >= 50 ? '✓' : '⚠️ MEJORAR'}
Promedio ganancia: +${avgWin.toFixed(2)}%
Promedio pérdida: -${avgLoss.toFixed(2)}%
Pérdidas consecutivas: ${consecutiveLosses} ${consecutiveLosses >= 3 ? '⚠️ REDUCIR RIESGO' : ''}

Últimos 5 trades:
${recentTrades.slice(0, 5).map(t =>
  `  ${t.pnl > 0 ? '✅' : '❌'} ${t.side} @ $${t.entryPrice.toFixed(2)} → ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}% (${t.exitReason}) [${t.gptConfidence}% conf]`
).join('\n') || '  Sin trades aún'}

🧠 APRENDIZAJES PREVIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${learnings.slice(0, 5).map(l => `• ${l}`).join('\n') || '• Aún sin aprendizajes - este es un buen momento para experimentar'}

💡 SUGERENCIAS BASADAS EN ATR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SL sugerido: $${suggestedSL.toFixed(2)} (~${((suggestedSL / analysis.price) * 100).toFixed(2)}% del precio)
TP sugerido: $${suggestedTP.toFixed(2)} (~${((suggestedTP / analysis.price) * 100).toFixed(2)}% del precio)
(Estos son sugerencias basadas en volatilidad, usa tu criterio)

═══════════════════════════════════════════════════════
TOMA TU DECISIÓN
═══════════════════════════════════════════════════════

Analiza TODO lo anterior y responde en JSON.
- Si ves oportunidad clara: BUY o SELL con parámetros específicos
- Si no estás seguro: HOLD (pero analiza para el próximo ciclo)
- Mínimo 45% de confianza para entrar
- Sé ESPECÍFICO en tu reasoning
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
        max_tokens: 200,
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
