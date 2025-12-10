// server.js - Pump.fun Sniper Bot API Server

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

console.log('🚀 Starting Pump.fun Sniper Bot Server...\n');
const envCleaner = cleanAndValidateEnv();

import express from 'express';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';
import { RiskManager } from './riskManager.js';
import { getSniperStats } from './flintrClient.js';
import { getCandleAnalyzer } from './candleAnalyzer.js';

const app = express();
app.use(express.json());

let redis = null;
const priceService = getPriceService();
const candleAnalyzer = getCandleAnalyzer();

if (process.env.REDIS_URL) {
  redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  redis.on('error', (err) => {
    console.log('⚠️ Redis error in server:', err?.message ?? String(err));
  });

  console.log('✅ Redis client initialized in server.js\n');
} else {
  console.log('⚠️ REDIS_URL not set - status endpoints will be limited\n');
}

function toNumber(value, def = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return def;
  return n;
}

// ═══════════════════════════════════════════════════════
// RUTAS BÁSICAS
// ═══════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    name: 'Pump.fun Sniper Bot API',
    mode: process.env.DRY_RUN !== 'false' ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
    version: 'v1-sniper',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    redis: !!redis,
    dryRun: process.env.DRY_RUN !== 'false',
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// /status - Estado general + P&L
// ═══════════════════════════════════════════════════════

app.get('/status', async (req, res) => {
  try {
    if (!redis) {
      return res.status(500).json({ error: 'Redis not available' });
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    const maxPositions = parseInt(process.env.MAX_POSITIONS || '3', 10);

    const riskManager = RiskManager.createFromEnv(redis);

    // PnL no realizado
    const openPnL = await riskManager.getOpenPnL();
    const allOpenPositions = openPnL.positions || [];

    const sniperPositions = allOpenPositions.filter(
      (p) =>
        p.entry_strategy === 'sniper' ||
        p.strategy === 'sniper',
    );

    const unrealizedSniperPnL = sniperPositions.reduce(
      (acc, p) => acc + toNumber(p.pnlSol, 0),
      0,
    );

    // Stats diarios
    let dailyStats = null;
    try {
      dailyStats = await riskManager.getDailyStats();
    } catch {}

    // Flintr stats
    const flintrStats = getSniperStats();

    // Candle analyzer stats
    const candleStats = candleAnalyzer.getStats();

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      maxPositions,
      sniper: {
        openPositions: sniperPositions.length,
        unrealizedPnL: Number(unrealizedSniperPnL.toFixed(4)),
      },
      allStrategies: {
        openPositions: allOpenPositions.length,
        totalUnrealizedPnL: openPnL.totalPnL,
        totalUnrealizedPnLPercent: openPnL.totalPnLPercent,
        totalSolEntry: openPnL.totalSolEntry,
        totalSolNow: openPnL.totalSolNow,
      },
      flintr: {
        tokensDetected: flintrStats.tokensDetected,
        tokensFiltered: flintrStats.tokensFiltered,
        tokensSniped: flintrStats.tokensSniped,
        filterRate: flintrStats.filterRate,
        snipeRate: flintrStats.snipeRate,
      },
      candleAnalyzer: {
        tokensTracked: candleStats.tokensTracked,
        totalDataPoints: candleStats.totalDataPoints,
        avgDataPointsPerToken: candleStats.avgDataPointsPerToken,
      },
      dailyStats: dailyStats || {
        date: null,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: '0.00%',
        totalPnL: 0,
        avgPnL: 0,
        biggestWin: 0,
        biggestLoss: 0,
        profitFactor: 0,
      },
      env: {
        DRY_RUN: process.env.DRY_RUN,
        ENABLE_AUTO_TRADING: process.env.ENABLE_AUTO_TRADING,
        POSITION_SIZE_SOL: process.env.POSITION_SIZE_SOL,
        MAX_POSITIONS: process.env.MAX_POSITIONS,
        REQUIRE_TWITTER: process.env.REQUIRE_TWITTER,
        MIN_BUNDLE_AMOUNT: process.env.MIN_BUNDLE_AMOUNT,
        REQUIRE_MOMENTUM: process.env.REQUIRE_MOMENTUM,
        CANDLE_ANALYSIS_DELAY_MS: process.env.CANDLE_ANALYSIS_DELAY_MS,
        STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED,
        STOP_LOSS_PERCENT: process.env.SNIPER_STOP_LOSS,
        TAKE_PROFIT_ENABLED: process.env.TAKE_PROFIT_ENABLED,
        TAKE_PROFIT_PERCENT: process.env.SNIPER_PROFIT_TARGET,
        TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED,
        TRAILING_STOP_PERCENT: process.env.SNIPER_TRAILING_STOP,
        AUTO_SELL_ON_GRADUATION: process.env.AUTO_SELL_ON_GRADUATION,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log('❌ /status error:', error?.message ?? String(error));
    res.status(500).json({ error: 'internal_error', message: error?.message });
  }
});

// ═══════════════════════════════════════════════════════
// /positions - Lista detallada de posiciones
// ═══════════════════════════════════════════════════════

app.get('/positions', async (req, res) => {
  try {
    if (!redis) {
      return res.status(500).json({ error: 'Redis not available' });
    }

    const riskManager = RiskManager.createFromEnv(redis);
    const openPnL = await riskManager.getOpenPnL();
    const positions = openPnL.positions || [];

    const sniperPositions = positions.filter(
      (p) =>
        p.entry_strategy === 'sniper' ||
        p.strategy === 'sniper',
    );

    res.json({
      count: sniperPositions.length,
      totalPnL: openPnL.totalPnL,
      totalPnLPercent: openPnL.totalPnLPercent,
      totalSolEntry: openPnL.totalSolEntry,
      totalSolNow: openPnL.totalSolNow,
      positions: sniperPositions,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log('❌ /positions error:', error?.message ?? String(error));
    res.status(500).json({ error: 'internal_error', message: error?.message });
  }
});

// ═══════════════════════════════════════════════════════
// /stats - P&L diario realizado
// ═══════════════════════════════════════════════════════

app.get('/stats', async (req, res) => {
  try {
    if (!redis) {
      return res.status(500).json({ error: 'Redis not available' });
    }

    const riskManager = RiskManager.createFromEnv(redis);
    const dailyStats = await riskManager.getDailyStats();

    res.json({
      dailyStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log('❌ /stats error:', error?.message ?? String(error));
    res.status(500).json({ error: 'internal_error', message: error?.message });
  }
});

// ═══════════════════════════════════════════════════════
// /candles/:mint - Análisis de velas de un token
// ═══════════════════════════════════════════════════════

app.get('/candles/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    
    if (!mint) {
      return res.status(400).json({ error: 'mint required' });
    }

    const analysis = await candleAnalyzer.updateAndAnalyze(mint);

    if (!analysis) {
      return res.status(404).json({ error: 'no_data_for_token' });
    }

    res.json({
      mint,
      analysis,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log('❌ /candles error:', error?.message ?? String(error));
    res.status(500).json({ error: 'internal_error', message: error?.message });
  }
});

// ═══════════════════════════════════════════════════════
// /env - Info de configuración
// ═══════════════════════════════════════════════════════

app.get('/env', (req, res) => {
  res.json({
    rpcUrl: process.env.RPC_URL,
    pumpProgramId: process.env.PUMP_PROGRAM_ID,
    dryRun: process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE',
    enableAutoTrading: process.env.ENABLE_AUTO_TRADING,
    telegramBotTokenSet: !!process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    flintrApiKeySet: !!process.env.FLINTR_API_KEY,
    positionSizeSOL: process.env.POSITION_SIZE_SOL,
    maxPositions: process.env.MAX_POSITIONS,
    requireTwitter: process.env.REQUIRE_TWITTER,
    minBundleAmount: process.env.MIN_BUNDLE_AMOUNT,
    requireMomentum: process.env.REQUIRE_MOMENTUM,
    candleAnalysisDelayMs: process.env.CANDLE_ANALYSIS_DELAY_MS,
    sniperStopLoss: process.env.SNIPER_STOP_LOSS,
    sniperProfitTarget: process.env.SNIPER_PROFIT_TARGET,
    sniperTrailingStop: process.env.SNIPER_TRAILING_STOP,
    autoSellOnGraduation: process.env.AUTO_SELL_ON_GRADUATION,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// Inicialización de módulos
// ═══════════════════════════════════════════════════════

async function initializeModules() {
  try {
    // Telegram
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { initTelegram } = await import('./telegram.js');
        await initTelegram();
        console.log('✅ Telegram bot started\n');
      } catch (error) {
        console.log('⚠️ Telegram bot failed:', error.message);
      }
    } else {
      console.log('⚠️ TELEGRAM_BOT_TOKEN missing - Telegram skipped\n');
    }

    console.log('🎯 Pump.fun Sniper Bot Configuration:');
    console.log(
      `   RPC_URL: ${process.env.RPC_URL || 'not set'} (DRY_RUN: ${
        process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE'
      })`,
    );
    console.log(
      `   Position Size: ${process.env.POSITION_SIZE_SOL || '0.05'} SOL`,
    );
    console.log(
      `   Max Positions: ${process.env.MAX_POSITIONS || '3'} (sniper strategy)`,
    );
    console.log(
      `   Require Twitter: ${process.env.REQUIRE_TWITTER || 'true'}`,
    );
    console.log(
      `   Min Bundle: ${process.env.MIN_BUNDLE_AMOUNT || '0.5'} SOL`,
    );
    console.log(
      `   Require Momentum: ${process.env.REQUIRE_MOMENTUM || 'true'}`,
    );
    console.log(
      `   Candle Analysis Delay: ${
        (parseInt(process.env.CANDLE_ANALYSIS_DELAY_MS || '30000') / 1000).toFixed(0)
      }s`,
    );
    console.log(
      `   Stop Loss: ${
        process.env.STOP_LOSS_ENABLED !== 'false'
          ? `Enabled (-${process.env.SNIPER_STOP_LOSS || '20'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Take Profit: ${
        process.env.TAKE_PROFIT_ENABLED !== 'false'
          ? `Enabled (+${process.env.SNIPER_PROFIT_TARGET || '150'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Trailing Stop: ${
        process.env.TRAILING_STOP_ENABLED !== 'false'
          ? `Enabled (-${process.env.SNIPER_TRAILING_STOP || '30'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   AUTO_SELL_ON_GRADUATION: ${
        process.env.AUTO_SELL_ON_GRADUATION === 'true' ? 'ON' : 'OFF'
      }\n`,
    );

    const mode =
      process.env.DRY_RUN !== 'false'
        ? '📄 PAPER TRADING'
        : '💰 LIVE TRADING';
    console.log(`🚀 Bot is ready in ${mode} mode\n`);
  } catch (error) {
    console.log('❌ Module initialization failed:', error.message);
  }
}

// ═══════════════════════════════════════════════════════
// Arrancar servidor
// ═══════════════════════════════════════════════════════

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}\n`);
  initializeModules();
});

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err?.message ?? String(err));
});
