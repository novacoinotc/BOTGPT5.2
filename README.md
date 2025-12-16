# GPT 5.2 Scalping Bot

Bot de trading inteligente para futuros de Binance, potenciado por GPT 5.2.

## Arquitectura

```m
┌─────────────────────────────────────────────────────────────────┐
│                        DASHBOARD (Vercel)                        │
│                     Next.js + Socket.IO Client                   │
└─────────────────────────────┬───────────────────────────────────┘
                              │ WebSocket + REaSTl
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BOT (Railway)                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Binance  │  │CryptoPanic│  │ GPT 5.2  │  │ Memory System    │ │
│  │  Client  │  │  Client   │  │  Engine  │  │ (Trades/Patterns)│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
│       │             │             │                  │           │
│       └─────────────┴─────────────┴──────────────────┘           │
│                              │                                    │
│                     ┌────────▼────────┐                          │
│                     │  Trading Engine  │                          │
│                     │    (Scalping)    │                          │
│                     └─────────────────┘                          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DATABASE (Neon)                             │
│                       PostgreSQL                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Features

- **GPT 5.2 Analysis**: Análisis inteligente del mercado con el modelo más avanzado
- **Scalping Strategy**: Operaciones rápidas con profits del 0.2-0.5%
- **Memory System**: Aprende de trades pasados y mejora decisiones
- **Multi-source Analysis**:
  - Technical Indicators (RSI, MACD, BB, ATR, ADX)
  - Order Book Analysis
  - Funding Rate Sentiment
  - CryptoPanic News
  - Fear & Greed Index
- **Real-time Dashboard**: Monitoreo en tiempo real vía WebSocket
- **Risk Management**: Stop-loss automático, sizing basado en riesgo

## Setup

### 1. Variables de Entorno

Crea un archivo `.env` con:

```env
# Binance
BINANCE_API_KEY=tu_api_key
BINANCE_SECRET_KEY=tu_secret_key

# Proxy (para servidores en USA)
PROXY_HOST=ip_del_proxy
PROXY_PORT=puerto
PROXY_USERNAME=usuario
PROXY_PASSWORD=password

# OpenAI
OPENAI_API_KEY=tu_openai_key

# CryptoPanic
CRYPTOPANIC_API_KEY=tu_cryptopanic_key

# Database
DATABASE_URL=tu_neon_url

# Trading
TRADING_ENABLED=true
MAX_LEVERAGE=20
RISK_PER_TRADE=0.02
```

### 2. Desarrollo Local

```bash
# Instalar dependencias
npm install

# Iniciar bot en desarrollo
npm run dev:bot

# Iniciar dashboard en desarrollo
npm run dev:dashboard
```

### 3. Deploy

**Bot (Railway):**
1. Conecta el repo a Railway
2. Configura las variables de entorno
3. Deploy automático desde `/bot`

**Dashboard (Vercel):**
1. Conecta el repo a Vercel
2. Root directory: `dashboard`
3. Configura `NEXT_PUBLIC_API_URL` con la URL de Railway

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/status` | GET | Estado del bot |
| `/api/stats` | GET | Estadísticas |
| `/api/trades` | GET | Historial de trades |
| `/api/analysis/:symbol` | GET | Análisis de mercado |
| `/api/news/:symbol` | GET | Noticias |
| `/api/feargreed` | GET | Fear & Greed Index |
| `/api/bot/start` | POST | Iniciar bot |
| `/api/bot/stop` | POST | Detener bot |
| `/api/positions/:symbol/close` | POST | Cerrar posición |

## WebSocket Events

- `status` - Estado inicial
- `botStatus` - Cambio de estado del bot
- `analysis` - Nuevo análisis
- `positionOpened` - Posición abierta
- `positionClosed` - Posición cerrada
- `positionUpdate` - Actualización de PnL
- `paperTrade` - Trade simulado (paper trading)

## Risk Management

- **Max Loss per Trade**: 0.5%
- **Position Sizing**: Basado en distancia a stop-loss
- **Consecutive Loss Protection**: Reduce tamaño después de 3 pérdidas
- **Max Hold Time**: 2 horas (scalping)
- **Confidence Threshold**: 65% para entrar

## License

MIT
