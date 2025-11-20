// worker.js - Pump.fun COPY TRADING Worker with ENV CLEANER + Flintr

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import IORedis from 'ioredis';
import { RiskManager } from './riskManager.js';
import { initWalletTracker } from './walletTracker.js';
import { startGraduationWatcher } from './graduationHandler.js';
import { startFlintrListener } from './flintrClient.js';

// ⚠️ Import side-effect: copyMonitor arranca sus loops internos
import './copyMonitor.js';

// 🧹 Limpiar/normalizar env primero
console.log('🚀 Starting Pump.fun Copy Trading Worker...\n');
const envCleaner = cleanAndValidateEnv();

function parseBoolEnv(value, defaultValue = false) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return defaultValue;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

async function startWorker() {
  // Verificar Redis
  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL not set - worker cannot start');
    return;
  }

  let redis;
  try {
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    });

    redis.on('error', (err) => {
      console.log('⚠️ Worker Redis error:', err?.message || String(err));
    });

    await redis.ping();
    console.log('✅ Worker Redis connected');
  } catch (error) {
    console.log('❌ Worker Redis connection failed:', error?.message || String(error));
    return;
  }

  const DRY_RUN = parseBoolEnv(process.env.DRY_RUN, true);
  const ENABLE_AUTO_TRADING = parseBoolEnv(process.env.ENABLE_AUTO_TRADING, true);

  console.log('\n🎯 Pump.fun COPY TRADING Worker Config:');
  console.log(`   Mode: ${DRY_RUN ? '📄 PAPER (DRY_RUN)' : '💰 LIVE'}`);
  console.log(`   ENABLE_AUTO_TRADING: ${ENABLE_AUTO_TRADING ? 'ON' : 'OFF'}`);
  console.log(`   POSITION_SIZE_SOL: ${process.env.POSITION_SIZE_SOL || '0.05'} SOL`);
  console.log(`   MAX_POSITIONS: ${process.env.MAX_POSITIONS || '2'} (copy strategy)`);
  console.log(`   MIN_LIQUIDITY_SOL: ${process.env.MIN_LIQUIDITY_SOL || '8'} SOL`);
  console.log(
    `   STOP_LOSS: ${
      parseBoolEnv(process.env.STOP_LOSS_ENABLED, false)
        ? `Enabled (-${process.env.STOP_LOSS_PERCENT || '13'}%)`
        : 'Disabled'
    }`,
  );
  console.log(
    `   TAKE_PROFIT: ${
      parseBoolEnv(process.env.TAKE_PROFIT_ENABLED, false)
        ? `Enabled (+${process.env.TAKE_PROFIT_PERCENT || '30'}%)`
        : 'Disabled'
    }`,
  );
  console.log(
    `   TRAILING_STOP: ${
      parseBoolEnv(process.env.TRAILING_STOP_ENABLED, false)
        ? `Enabled (-${process.env.TRAILING_STOP_PERCENT || '15'}%)`
        : 'Disabled'
    }`,
  );
  console.log(
    `   AUTO_SELL_ON_GRADUATION: ${
      parseBoolEnv(process.env.AUTO_SELL_ON_GRADUATION, false) ? 'ON' : 'OFF'
    }\n`,
  );

  try {
    // 1) RiskManager (para stats + P&L)
    const riskManager = RiskManager.createFromEnv(redis);

    // 2) Graduation watcher (marca posiciones graduadas + force_exit)
    const graduationHandler = startGraduationWatcher(redis);
    console.log('🎓 Graduation watcher started from worker');

    // 3) Wallet Tracker (genera copy_signals / sell_signals)
    const tracker = await initWalletTracker();
    if (!tracker) {
      console.log('⚠️ WalletTracker not started (RPC_URL or wallets missing)');
    } else {
      console.log('👁️ WalletTracker started (copy signals will be generated)');
    }

    // 4) Flintr listener - solo para metadata de tokens (Pump.fun)
    const flintrWs = startFlintrListener(redis);
    if (flintrWs) {
      console.log('🔥 Flintr listener running (metadata cache for Pump.fun tokens)');
    } else {
      console.log('⚠️ Flintr listener not started (no FLINTR_API_KEY or Redis issue)');
    }

    // 5) copyMonitor ya está corriendo por el import (loops internos)
    console.log('🧠 copyMonitor loops are running (BUY/SELL logic + HYBRID exits)');

    // 6) Stats periódicos (usa RiskManager + Redis)
    const statsIntervalMs = parseInt(
      process.env.RISK_TICK_INTERVAL || '120000',
      10,
    );

    setInterval(async () => {
      try {
        const openPositions = await redis.scard('open_positions');
        const copySignals = await redis.llen('copy_signals');
        const sellSignals = await redis.llen('sell_signals');

        console.log('\n📊 Worker Status (Copy Trading):');
        console.log(`   Open Positions: ${openPositions}`);
        console.log(`   Copy Signals in queue: ${copySignals}`);
        console.log(`   Sell Signals in queue: ${sellSignals}`);

        try {
          const stats = await riskManager.getDailyStats();
          if (stats && stats.totalTrades > 0) {
            console.log('   📈 Today Stats (realized):');
            console.log(
              `   Trades: ${stats.totalTrades} | Wins: ${stats.wins} | Losses: ${stats.losses}`,
            );
            console.log(
              `   WinRate: ${stats.winRate} | Total P&L: ${stats.totalPnL} SOL`,
            );
            console.log(
              `   Biggest Win: ${stats.biggestWin} SOL | Biggest Loss: ${stats.biggestLoss} SOL`,
            );
          } else {
            console.log('   📈 Today Stats: no trades yet');
          }
        } catch {
          // Stats no disponibles aún
        }

        console.log('');
      } catch {
        // silencioso para no spamear
      }
    }, statsIntervalMs);

    console.log('✅ Pump.fun COPY TRADING Worker is running');
    console.log('   WalletTracker → Redis(copy_signals/sell_signals) → copyMonitor + Flintr\n');
  } catch (error) {
    console.log('❌ Worker setup failed:', error?.message || String(error));
    process.exit(1);
  }
}

// Manejo de errores global
process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err?.message || String(err));
});

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down worker...');
  try {
    // Aquí en el futuro podrías cerrar conexiones WS del WalletTracker, etc.
  } catch {}
  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// Iniciar el worker
startWorker();
