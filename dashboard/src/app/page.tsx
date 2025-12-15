'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, BotStatus, Statistics, Trade, Analysis, FearGreed } from '@/lib/api';
import { socketService } from '@/lib/socket';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  DollarSign,
  BarChart3,
  Brain,
  Zap,
  AlertTriangle,
  Play,
  Square,
  RefreshCw,
  Target,
  Shield,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';

export default function Dashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [stats, setStats] = useState<Statistics | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [fearGreed, setFearGreed] = useState<FearGreed | null>(null);
  const [learnings, setLearnings] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);

  // Fetch initial data
  const fetchData = useCallback(async () => {
    try {
      const [statusData, statsData, tradesData, fearGreedData, learningsData] =
        await Promise.all([
          api.getStatus(),
          api.getStats(),
          api.getTrades(20),
          api.getFearGreed(),
          api.getLearnings(),
        ]);

      setStatus(statusData);
      setStats(statsData);
      setTrades(tradesData);
      setFearGreed(fearGreedData);
      setLearnings(learningsData);

      if (statusData.symbols.length > 0) {
        const analysisData = await api.getAnalysis(statusData.symbols[0]);
        setAnalysis(analysisData);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Socket connection
  useEffect(() => {
    socketService.connect();
    setConnected(socketService.isConnected());

    socketService.on('status', (data: any) => {
      setStatus(prev => prev ? { ...prev, ...data } : data);
    });

    socketService.on('botStatus', (data: { isRunning: boolean }) => {
      setStatus(prev => prev ? { ...prev, isRunning: data.isRunning } : null);
    });

    socketService.on('analysis', (data: any) => {
      if (data.symbol === selectedSymbol) {
        setAnalysis(data);
      }
    });

    socketService.on('positionOpened', (position: any) => {
      setStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          openPositions: [...prev.openPositions, position],
        };
      });
    });

    socketService.on('positionClosed', (data: any) => {
      setStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          openPositions: prev.openPositions.filter(
            p => p.symbol !== data.position.symbol
          ),
          todayPnl: prev.todayPnl + (data.pnlUsd || 0),
        };
      });
      // Refresh trades
      api.getTrades(20).then(setTrades);
      api.getStats().then(setStats);
    });

    socketService.on('positionUpdate', (data: any) => {
      setStatus(prev => {
        if (!prev) return null;
        return {
          ...prev,
          openPositions: prev.openPositions.map(p =>
            p.symbol === data.symbol ? { ...p, currentPrice: data.currentPrice, pnl: data.pnl } : p
          ),
        };
      });
    });

    return () => {
      socketService.disconnect();
    };
  }, [selectedSymbol]);

  // Initial fetch
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Bot control
  const handleStartBot = async () => {
    try {
      await api.startBot();
      setStatus(prev => prev ? { ...prev, isRunning: true } : null);
    } catch (error) {
      console.error('Failed to start bot:', error);
    }
  };

  const handleStopBot = async () => {
    try {
      await api.stopBot();
      setStatus(prev => prev ? { ...prev, isRunning: false } : null);
    } catch (error) {
      console.error('Failed to stop bot:', error);
    }
  };

  const handleClosePosition = async (symbol: string) => {
    try {
      await api.closePosition(symbol);
    } catch (error) {
      console.error('Failed to close position:', error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-gray-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Brain className="w-10 h-10 text-purple-500" />
          <div>
            <h1 className="text-2xl font-bold">GPT 5.2 Scalping Bot</h1>
            <p className="text-gray-400 text-sm">Intelligent Futures Trading</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Connection status */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                connected ? 'bg-green-500 pulse-green' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-400">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* Bot control */}
          {status?.isRunning ? (
            <button
              onClick={handleStopBot}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition"
            >
              <Square className="w-4 h-4" />
              Stop Bot
            </button>
          ) : (
            <button
              onClick={handleStartBot}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition"
            >
              <Play className="w-4 h-4" />
              Start Bot
            </button>
          )}

          <button
            onClick={fetchData}
            className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          title="Balance"
          value={`$${status?.balance.toFixed(2) || '0.00'}`}
          icon={<DollarSign className="w-5 h-5" />}
          color="blue"
        />
        <StatCard
          title="Today's PnL"
          value={`${(status?.todayPnl || 0) >= 0 ? '+' : ''}$${(status?.todayPnl || 0).toFixed(2)}`}
          icon={<TrendingUp className="w-5 h-5" />}
          color={(status?.todayPnl || 0) >= 0 ? 'green' : 'red'}
        />
        <StatCard
          title="Win Rate"
          value={`${stats?.winRate.toFixed(1) || '0'}%`}
          icon={<Target className="w-5 h-5" />}
          color={stats && stats.winRate >= 50 ? 'green' : 'yellow'}
        />
        <StatCard
          title="Today's Trades"
          value={status?.todayTrades.toString() || '0'}
          icon={<Activity className="w-5 h-5" />}
          color="purple"
        />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Positions & Analysis */}
        <div className="lg:col-span-2 space-y-6">
          {/* Open Positions */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title flex items-center gap-2">
                <Zap className="w-5 h-5 text-yellow-500" />
                Open Positions
              </h2>
              <span className="badge badge-info">
                {status?.openPositions.length || 0} active
              </span>
            </div>

            {status?.openPositions.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No open positions</p>
            ) : (
              <div className="space-y-3">
                {status?.openPositions.map(position => (
                  <div
                    key={position.symbol}
                    className="bg-gray-800/50 rounded-lg p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`px-2 py-1 rounded text-sm font-bold ${
                          position.side === 'LONG'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-red-500/20 text-red-400'
                        }`}
                      >
                        {position.side}
                      </div>
                      <div>
                        <p className="font-semibold">{position.symbol}</p>
                        <p className="text-sm text-gray-400">
                          Entry: ${position.entryPrice.toFixed(2)} | {position.leverage}x
                        </p>
                      </div>
                    </div>

                    <div className="text-right">
                      {position.pnl !== undefined && (
                        <p
                          className={`font-bold ${
                            position.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}
                        >
                          {position.pnl >= 0 ? '+' : ''}
                          {position.pnl.toFixed(2)}%
                        </p>
                      )}
                      <p className="text-sm text-gray-400">
                        GPT: {position.gptConfidence}%
                      </p>
                    </div>

                    <button
                      onClick={() => handleClosePosition(position.symbol)}
                      className="px-3 py-1 bg-red-600/20 text-red-400 rounded hover:bg-red-600/40 transition"
                    >
                      Close
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Market Analysis */}
          {analysis && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-blue-500" />
                  Market Analysis - {analysis.analysis.symbol}
                </h2>
                <span
                  className={`badge ${
                    analysis.analysis.change24h >= 0
                      ? 'badge-success'
                      : 'badge-danger'
                  }`}
                >
                  {analysis.analysis.change24h >= 0 ? '+' : ''}
                  {analysis.analysis.change24h.toFixed(2)}%
                </span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <Indicator
                  label="RSI"
                  value={analysis.analysis.indicators.rsi.toFixed(1)}
                  status={
                    analysis.analysis.indicators.rsi > 70
                      ? 'overbought'
                      : analysis.analysis.indicators.rsi < 30
                      ? 'oversold'
                      : 'neutral'
                  }
                />
                <Indicator
                  label="MACD"
                  value={analysis.analysis.indicators.macd.histogram.toFixed(4)}
                  status={
                    analysis.analysis.indicators.macd.histogram > 0
                      ? 'bullish'
                      : 'bearish'
                  }
                />
                <Indicator
                  label="ADX"
                  value={analysis.analysis.indicators.adx.toFixed(1)}
                  status={
                    analysis.analysis.indicators.adx > 25 ? 'trending' : 'ranging'
                  }
                />
                <Indicator
                  label="Funding"
                  value={`${(analysis.analysis.funding.rate * 100).toFixed(4)}%`}
                  status={analysis.analysis.funding.sentiment}
                />
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-gray-800/30 rounded-lg p-3">
                  <p className="text-sm text-gray-400 mb-1">Order Book</p>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-2 bg-green-500 rounded"
                      style={{
                        width: `${analysis.analysis.orderBook.bidPressure * 100}%`,
                      }}
                    />
                    <div
                      className="h-2 bg-red-500 rounded"
                      style={{
                        width: `${analysis.analysis.orderBook.askPressure * 100}%`,
                      }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Imbalance: {(analysis.analysis.orderBook.imbalance * 100).toFixed(1)}%
                  </p>
                </div>

                <div className="bg-gray-800/30 rounded-lg p-3">
                  <p className="text-sm text-gray-400 mb-1">Regime</p>
                  <p
                    className={`font-semibold ${
                      analysis.analysis.regime === 'trending_up'
                        ? 'text-green-400'
                        : analysis.analysis.regime === 'trending_down'
                        ? 'text-red-400'
                        : 'text-yellow-400'
                    }`}
                  >
                    {analysis.analysis.regime.replace('_', ' ').toUpperCase()}
                  </p>
                </div>
              </div>

              {/* GPT Decision */}
              {analysis.lastDecision && (
                <div className="bg-purple-900/20 border border-purple-500/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <span className="font-semibold text-purple-400">GPT Decision</span>
                    <span
                      className={`badge ml-auto ${
                        analysis.lastDecision.action === 'BUY'
                          ? 'badge-success'
                          : analysis.lastDecision.action === 'SELL'
                          ? 'badge-danger'
                          : 'badge-warning'
                      }`}
                    >
                      {analysis.lastDecision.action} ({analysis.lastDecision.confidence}%)
                    </span>
                  </div>
                  <p className="text-sm text-gray-300">{analysis.lastDecision.reasoning}</p>
                  {analysis.lastDecision.patterns.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2">
                      Patterns: {analysis.lastDecision.patterns.join(', ')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Recent Trades */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Recent Trades</h2>
              <span className="text-sm text-gray-400">
                {trades.length} total
              </span>
            </div>

            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800">
                    <th className="text-left py-2">Symbol</th>
                    <th className="text-left py-2">Side</th>
                    <th className="text-right py-2">Entry</th>
                    <th className="text-right py-2">Exit</th>
                    <th className="text-right py-2">PnL</th>
                    <th className="text-left py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(trade => (
                    <tr key={trade.id} className="border-b border-gray-800/50">
                      <td className="py-2">{trade.symbol}</td>
                      <td>
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${
                            trade.side === 'LONG'
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {trade.side}
                        </span>
                      </td>
                      <td className="text-right">${trade.entryPrice.toFixed(2)}</td>
                      <td className="text-right">${trade.exitPrice.toFixed(2)}</td>
                      <td
                        className={`text-right font-medium ${
                          trade.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {trade.pnl >= 0 ? '+' : ''}
                        {trade.pnl.toFixed(2)}%
                      </td>
                      <td className="text-gray-400">{trade.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column - Stats & Learnings */}
        <div className="space-y-6">
          {/* Fear & Greed */}
          {fearGreed && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                  Fear & Greed Index
                </h2>
              </div>

              <div className="text-center">
                <div className="relative w-32 h-32 mx-auto mb-4">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="12"
                      fill="none"
                      className="text-gray-700"
                    />
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="12"
                      fill="none"
                      strokeDasharray={`${(fearGreed.value / 100) * 352} 352`}
                      className={
                        fearGreed.value <= 25
                          ? 'text-red-500'
                          : fearGreed.value <= 45
                          ? 'text-orange-500'
                          : fearGreed.value <= 55
                          ? 'text-yellow-500'
                          : fearGreed.value <= 75
                          ? 'text-lime-500'
                          : 'text-green-500'
                      }
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-3xl font-bold">{fearGreed.value}</span>
                  </div>
                </div>
                <p
                  className={`font-semibold ${
                    fearGreed.value <= 25
                      ? 'text-red-400'
                      : fearGreed.value <= 45
                      ? 'text-orange-400'
                      : fearGreed.value <= 55
                      ? 'text-yellow-400'
                      : fearGreed.value <= 75
                      ? 'text-lime-400'
                      : 'text-green-400'
                  }`}
                >
                  {fearGreed.classification}
                </p>
              </div>
            </div>
          )}

          {/* Statistics */}
          {stats && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title flex items-center gap-2">
                  <Shield className="w-5 h-5 text-blue-500" />
                  Statistics
                </h2>
              </div>

              <div className="space-y-3">
                <StatRow label="Total Trades" value={stats.totalTrades.toString()} />
                <StatRow
                  label="Win Rate"
                  value={`${stats.winRate.toFixed(1)}%`}
                  color={stats.winRate >= 50 ? 'green' : 'red'}
                />
                <StatRow
                  label="Avg PnL"
                  value={`${stats.averagePnl >= 0 ? '+' : ''}${stats.averagePnl.toFixed(2)}%`}
                  color={stats.averagePnl >= 0 ? 'green' : 'red'}
                />
                <StatRow
                  label="Total PnL"
                  value={`$${stats.totalPnlUsd.toFixed(2)}`}
                  color={stats.totalPnlUsd >= 0 ? 'green' : 'red'}
                />
                <StatRow
                  label="Avg Hold Time"
                  value={`${stats.avgHoldTime.toFixed(1)} min`}
                />
                <StatRow
                  label="Consecutive Losses"
                  value={stats.consecutiveLosses.toString()}
                  color={stats.consecutiveLosses >= 3 ? 'red' : 'neutral'}
                />
                {stats.bestTrade && (
                  <StatRow
                    label="Best Trade"
                    value={`+${stats.bestTrade.pnl.toFixed(2)}%`}
                    color="green"
                  />
                )}
                {stats.worstTrade && (
                  <StatRow
                    label="Worst Trade"
                    value={`${stats.worstTrade.pnl.toFixed(2)}%`}
                    color="red"
                  />
                )}
              </div>
            </div>
          )}

          {/* Learnings */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title flex items-center gap-2">
                <Brain className="w-5 h-5 text-purple-500" />
                Bot Learnings
              </h2>
            </div>

            {learnings.length === 0 ? (
              <p className="text-gray-500 text-center py-4">No learnings yet</p>
            ) : (
              <ul className="space-y-2">
                {learnings.slice(0, 8).map((learning, i) => (
                  <li
                    key={i}
                    className="text-sm text-gray-300 bg-gray-800/30 rounded p-2"
                  >
                    {learning}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Symbols */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Trading Symbols</h2>
            </div>

            <div className="flex flex-wrap gap-2">
              {status?.symbols.map(symbol => (
                <span
                  key={symbol}
                  className={`px-3 py-1 rounded-full text-sm cursor-pointer transition ${
                    selectedSymbol === symbol
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                  }`}
                  onClick={() => setSelectedSymbol(symbol)}
                >
                  {symbol}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Components
function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'red' | 'yellow' | 'purple';
}) {
  const colors = {
    blue: 'from-blue-600/20 to-blue-600/5 border-blue-500/30',
    green: 'from-green-600/20 to-green-600/5 border-green-500/30',
    red: 'from-red-600/20 to-red-600/5 border-red-500/30',
    yellow: 'from-yellow-600/20 to-yellow-600/5 border-yellow-500/30',
    purple: 'from-purple-600/20 to-purple-600/5 border-purple-500/30',
  };

  const iconColors = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    purple: 'text-purple-400',
  };

  return (
    <div
      className={`bg-gradient-to-br ${colors[color]} border rounded-xl p-4`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-400">{title}</span>
        <span className={iconColors[color]}>{icon}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

function Indicator({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: string;
}) {
  const statusColors: Record<string, string> = {
    overbought: 'text-red-400',
    oversold: 'text-green-400',
    bullish: 'text-green-400',
    bearish: 'text-red-400',
    trending: 'text-blue-400',
    ranging: 'text-yellow-400',
    neutral: 'text-gray-400',
  };

  return (
    <div className="bg-gray-800/30 rounded-lg p-3 text-center">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`font-semibold ${statusColors[status] || 'text-white'}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500 capitalize">{status}</p>
    </div>
  );
}

function StatRow({
  label,
  value,
  color = 'neutral',
}: {
  label: string;
  value: string;
  color?: 'green' | 'red' | 'neutral';
}) {
  const colors = {
    green: 'text-green-400',
    red: 'text-red-400',
    neutral: 'text-white',
  };

  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-400">{label}</span>
      <span className={`font-medium ${colors[color]}`}>{value}</span>
    </div>
  );
}
