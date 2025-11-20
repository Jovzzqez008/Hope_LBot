// server.js - Pump.fun Copy Trading Bot API with ENV CLEANER

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

// 🧹 Limpiar/validar ENV primero
console.log('🚀 Starting Pump.fun Copy Trading Bot Server...\n');
const envCleaner = cleanAndValidateEnv();

import express from 'express';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';
import { RiskManager } from './riskManager.js';

const app = express();
app.use(express.json());

let redis = null;
const priceService = getPriceService();

// Inicializar Redis
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

// Helper: normalizar número
function toNumber(value, def = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return def;
  return n;
}

// ═══════════════════════════════════════════════════════
// RUTAS BÁSICAS
// ═══════════════════════════════════════════════════════

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Pump.fun Copy Trading Bot API',
    mode: process.env.DRY_RUN !== 'false' ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
    version: 'v2-copy-only',
    timestamp: new Date().toISOString(),
  });
});

// Healthcheck simple
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    redis: !!redis,
    dryRun: process.env.DRY_RUN !== 'false',
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// /status - Estado general + P&L (usando RiskManager nuevo)
// ═══════════════════════════════════════════════════════

app.get('/status', async (req, res) => {
  try {
    if (!redis) {
      return res.status(500).json({ error: 'Redis not available' });
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);

    const riskManager = RiskManager.createFromEnv(redis);

    // PnL no realizado (todas las posiciones)
    const openPnL = await riskManager.getOpenPnL();
    const allOpenPositions = openPnL.positions || [];

    // Solo posiciones de copy trading
    const copyPositions = allOpenPositions.filter(
      (p) =>
        p.entry_strategy === 'copy' ||
        p.entry_strategy === 'copy_trading' ||
        p.strategy === 'copy',
    );

    const unrealizedCopyPnL = copyPositions.reduce(
      (acc, p) => acc + (toNumber(p.pnlSol, 0)),
      0,
    );

    // Stats diarios (realizado)
    let dailyStats = null;
    try {
      dailyStats = await riskManager.getDailyStats();
    } catch {
      dailyStats = null;
    }

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      maxPositions,
      copy: {
        openPositions: copyPositions.length,
        unrealizedPnL: Number(unrealizedCopyPnL.toFixed(4)),
      },
      allStrategies: {
        openPositions: allOpenPositions.length,
        totalUnrealizedPnL: openPnL.totalPnL,
        totalUnrealizedPnLPercent: openPnL.totalPnLPercent,
        totalSolEntry: openPnL.totalSolEntry,
        totalSolNow: openPnL.totalSolNow,
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
        MIN_LIQUIDITY_SOL: process.env.MIN_LIQUIDITY_SOL,
        STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED,
        STOP_LOSS_PERCENT: process.env.STOP_LOSS_PERCENT,
        TAKE_PROFIT_ENABLED: process.env.TAKE_PROFIT_ENABLED,
        TAKE_PROFIT_PERCENT: process.env.TAKE_PROFIT_PERCENT,
        TRAILING_STOP_ENABLED: process.env.TRAILING_STOP_ENABLED,
        TRAILING_STOP_PERCENT: process.env.TRAILING_STOP_PERCENT,
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
// /positions - Lista detallada de posiciones abiertas
// ═══════════════════════════════════════════════════════

app.get('/positions', async (req, res) => {
  try {
    if (!redis) {
      return res.status(500).json({ error: 'Redis not available' });
    }

    const riskManager = RiskManager.createFromEnv(redis);
    const openPnL = await riskManager.getOpenPnL();
    const positions = openPnL.positions || [];

    // Puedes filtrar solo copy si quieres, pero aquí devolvemos todas
    res.json({
      count: positions.length,
      totalPnL: openPnL.totalPnL,
      totalPnLPercent: openPnL.totalPnLPercent,
      totalSolEntry: openPnL.totalSolEntry,
      totalSolNow: openPnL.totalSolNow,
      positions,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.log('❌ /positions error:', error?.message ?? String(error));
    res.status(500).json({ error: 'internal_error', message: error?.message });
  }
});

// ═══════════════════════════════════════════════════════
// /stats - P&L diario realizado (journal de trades)
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
// /env - Info de configuración útil para debug / panel
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
    minLiquiditySOL: process.env.MIN_LIQUIDITY_SOL,
    stopLossPercent: process.env.STOP_LOSS_PERCENT,
    takeProfitPercent: process.env.TAKE_PROFIT_PERCENT,
    trailingStopPercent: process.env.TRAILING_STOP_PERCENT,
    autoSellOnGraduation: process.env.AUTO_SELL_ON_GRADUATION,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════
// Inicialización de módulos (Telegram, logs de config)
// ═══════════════════════════════════════════════════════

async function initializeModules() {
  try {
    // 1) Telegram
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

    // 2) Log de configuración copy trading
    console.log('🎯 Pump.fun Copy Trading Configuration:');
    console.log(
      `   RPC_URL: ${process.env.RPC_URL || 'not set'} (DRY_RUN: ${
        process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE'
      })`,
    );
    console.log(
      `   Position Size: ${process.env.POSITION_SIZE_SOL || '0.05'} SOL`,
    );
    console.log(
      `   Max Positions: ${process.env.MAX_POSITIONS || '2'} (copy strategy)`,
    );
    console.log(
      `   Min Liquidity: ${process.env.MIN_LIQUIDITY_SOL || '8'} SOL`,
    );
    console.log(
      `   Stop Loss: ${
        (process.env.STOP_LOSS_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (-${process.env.STOP_LOSS_PERCENT || '13'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Take Profit: ${
        (process.env.TAKE_PROFIT_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (+${process.env.TAKE_PROFIT_PERCENT || '30'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Trailing Stop: ${
        (process.env.TRAILING_STOP_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (-${process.env.TRAILING_STOP_PERCENT || '15'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   AUTO_SELL_ON_GRADUATION: ${
        (process.env.AUTO_SELL_ON_GRADUATION || '')
          .trim()
          .toLowerCase() === 'true'
          ? 'ON'
          : 'OFF'
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
