import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { MarketAnalysis } from '../market/analyzer.js';
import { memorySystem, TradeMemory } from '../memory/index.js';

interface GPTDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-100
  reasoning: string;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number; // % of capital
  riskLevel: 'low' | 'medium' | 'high';
  timeframe: string;
  patterns: string[];
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
}

export class GPTEngine {
  private client: OpenAI;
  private model = 'gpt-5.2'; // Latest GPT 5.2

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }

  async analyze(context: MarketContext): Promise<GPTDecision> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildAnalysisPrompt(context);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3, // Lower for more consistent trading decisions
        response_format: { type: 'json_object' },
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from GPT');
      }

      const decision = JSON.parse(content) as GPTDecision;

      // Store the analysis for learning
      await this.storeAnalysis(context, decision);

      return decision;
    } catch (error) {
      console.error('[GPT] Analysis error:', error);
      return this.getDefaultDecision();
    }
  }

  private buildSystemPrompt(): string {
    return `Eres un trader experto de futuros de criptomonedas especializado en SCALPING.
Tu objetivo es hacer muchos trades pequeños con profits del 0.2%-0.5% cada uno.

REGLAS CRÍTICAS:
1. SIEMPRE usa stop loss. Máximo 0.5% de pérdida por trade.
2. Busca setups de alta probabilidad (>70% confianza para entrar).
3. Aprende de los trades pasados - analiza qué funcionó y qué no.
4. Considera el contexto macro (Fear & Greed, noticias, funding rate).
5. En mercado lateral, usa mean reversion. En tendencia, sigue la tendencia.
6. NUNCA seas codicioso. Toma profits rápidos.
7. Si el spread es muy alto o hay baja liquidez, NO operes.

ANÁLISIS QUE DEBES HACER:
- Order book: ¿Hay más presión compradora o vendedora?
- RSI: <30 sobreventa (compra), >70 sobrecompra (venta)
- MACD: Busca cruces y divergencias
- Bollinger Bands: Precio cerca de bandas = posible reversión
- Funding Rate: Muy positivo = mercado muy alcista (cuidado con longs)
- Noticias: ¿Hay catalizadores que muevan el precio?
- Volumen: ¿El movimiento tiene volumen? Sin volumen = fake move

GESTIÓN DE RIESGO:
- Máximo 2% del capital por trade
- Stop loss obligatorio
- Take profit en zonas de resistencia/soporte
- Si perdiste 3 trades seguidos, reduce tamaño de posición

Responde SIEMPRE en formato JSON con esta estructura:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": 0-100,
  "reasoning": "explicación corta",
  "entryPrice": number (precio de entrada sugerido),
  "stopLoss": number,
  "takeProfit": number,
  "positionSize": 0-100 (% del capital máximo permitido),
  "riskLevel": "low" | "medium" | "high",
  "timeframe": "1m" | "5m" | "15m",
  "patterns": ["patrón1", "patrón2"]
}`;
  }

  private buildAnalysisPrompt(context: MarketContext): string {
    const { analysis, news, fearGreed, recentTrades, learnings } = context;

    // Calculate win rate from recent trades
    const wins = recentTrades.filter(t => t.pnl > 0).length;
    const winRate = recentTrades.length > 0 ? (wins / recentTrades.length) * 100 : 0;
    const avgPnl = recentTrades.length > 0
      ? recentTrades.reduce((sum, t) => sum + t.pnl, 0) / recentTrades.length
      : 0;

    return `
ANÁLISIS DE MERCADO - ${analysis.symbol}
========================================

PRECIO Y CAMBIO:
- Precio actual: $${analysis.price.toFixed(2)}
- Cambio 24h: ${analysis.change24h.toFixed(2)}%
- Volumen 24h: $${(analysis.volume24h / 1000000).toFixed(2)}M

INDICADORES TÉCNICOS:
- RSI(14): ${analysis.indicators.rsi.toFixed(1)}
- MACD: ${analysis.indicators.macd.histogram.toFixed(4)} (${analysis.indicators.macd.histogram > 0 ? 'ALCISTA' : 'BAJISTA'})
- EMA9: $${analysis.indicators.ema9.toFixed(2)} ${analysis.price > analysis.indicators.ema9 ? '(precio arriba)' : '(precio abajo)'}
- EMA21: $${analysis.indicators.ema21.toFixed(2)}
- SMA50: $${analysis.indicators.sma50.toFixed(2)}
- Bollinger Bands: Upper $${analysis.indicators.bollingerBands.upper.toFixed(2)} | Lower $${analysis.indicators.bollingerBands.lower.toFixed(2)}
- ATR(14): $${analysis.indicators.atr.toFixed(2)} (volatilidad)
- ADX: ${analysis.indicators.adx.toFixed(1)} (${analysis.indicators.adx > 25 ? 'TENDENCIA' : 'RANGO'})

ORDER BOOK:
- Presión compradora: ${(analysis.orderBook.bidPressure * 100).toFixed(1)}%
- Presión vendedora: ${(analysis.orderBook.askPressure * 100).toFixed(1)}%
- Imbalance: ${(analysis.orderBook.imbalance * 100).toFixed(1)}% ${analysis.orderBook.imbalance > 0 ? '(más compradores)' : '(más vendedores)'}
- Spread: ${analysis.orderBook.spreadPercent.toFixed(4)}%
- Muros de compra: ${analysis.orderBook.bigBuyWalls.slice(0, 3).map(p => '$' + p.toFixed(2)).join(', ') || 'ninguno'}
- Muros de venta: ${analysis.orderBook.bigSellWalls.slice(0, 3).map(p => '$' + p.toFixed(2)).join(', ') || 'ninguno'}

FUNDING RATE:
- Rate: ${(analysis.funding.rate * 100).toFixed(4)}%
- Sentimiento: ${analysis.funding.sentiment.toUpperCase()}

RÉGIMEN DE MERCADO: ${analysis.regime.toUpperCase()}

VOLUME PROFILE:
- POC (Point of Control): $${analysis.volumeProfile.poc.toFixed(2)}
- Value Area High: $${analysis.volumeProfile.valueAreaHigh.toFixed(2)}
- Value Area Low: $${analysis.volumeProfile.valueAreaLow.toFixed(2)}

NOTICIAS Y SENTIMIENTO:
- Fear & Greed Index: ${fearGreed.value} (${fearGreed.classification})
- Sentimiento noticias: ${(news.sentiment.score * 100).toFixed(0)}%
- Headlines recientes:
${news.headlines.slice(0, 3).map(h => `  • ${h}`).join('\n') || '  • Sin noticias relevantes'}

HISTORIAL DE TRADES RECIENTES:
- Total trades: ${recentTrades.length}
- Win Rate: ${winRate.toFixed(1)}%
- PnL promedio: ${avgPnl.toFixed(2)}%
${recentTrades.slice(0, 5).map(t =>
  `  • ${t.side} @ $${t.entryPrice.toFixed(2)} → ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}% (${t.exitReason})`
).join('\n')}

APRENDIZAJES PREVIOS:
${learnings.slice(0, 5).map(l => `• ${l}`).join('\n') || '• Sin aprendizajes aún'}

========================================
Analiza toda esta información y decide si es buen momento para:
1. Abrir LONG (BUY)
2. Abrir SHORT (SELL)
3. Esperar (HOLD)

Recuerda: Estamos haciendo SCALPING. Busca entradas de alta probabilidad con TP rápido.
`;
  }

  private async storeAnalysis(context: MarketContext, decision: GPTDecision): Promise<void> {
    // Store for pattern learning
    if (decision.action !== 'HOLD' && decision.confidence >= 60) {
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
      reasoning: 'Error en análisis, mantener posición',
      riskLevel: 'high',
      timeframe: '5m',
      patterns: [],
    };
  }

  // Learn from completed trade
  async learnFromTrade(trade: TradeMemory): Promise<string> {
    const prompt = `
Analiza este trade completado y extrae una lección aprendida:

Trade: ${trade.side} ${trade.symbol}
Entrada: $${trade.entryPrice}
Salida: $${trade.exitPrice}
PnL: ${trade.pnl > 0 ? '+' : ''}${trade.pnl.toFixed(2)}%
Razón de salida: ${trade.exitReason}
Duración: ${((trade.exitTime - trade.entryTime) / 60000).toFixed(1)} minutos
Condiciones de entrada: RSI=${trade.entryConditions.rsi.toFixed(1)}, Régimen=${trade.entryConditions.regime}

${trade.pnl > 0
  ? '¿Qué hicimos bien? ¿Podríamos haber obtenido más profit?'
  : '¿Qué salió mal? ¿Cómo evitarlo en el futuro?'}

Responde con UNA sola lección concisa (máximo 100 caracteres).
`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.5,
      });

      const lesson = response.choices[0]?.message?.content || '';

      // Store the learning
      await memorySystem.storeLearning(lesson, trade.pnl > 0 ? 'success' : 'failure', {
        symbol: trade.symbol,
        pnl: trade.pnl,
        regime: trade.entryConditions.regime,
      });

      return lesson;
    } catch (error) {
      console.error('[GPT] Learning error:', error);
      return '';
    }
  }
}

export const gptEngine = new GPTEngine();
