// worker.js - Pump.fun SNIPER Worker
// ✅ Sniper de tokens nuevos con análisis de momentum
// ✅ Filtros: Twitter, bundle, velas
// ✅ Monitoreo en tiempo real con RPC

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import IORedis from 'ioredis';
import { RiskManager } from './riskManager.js';
import { startFlintrSniper } from './flintrClient.js';
import { getSniperStrategy } from './sniperStrategy.js';
import { getCandleAnalyzer } from './candleAnalyzer.js';
import { startGraduationWatcher } from './graduationHandler.js';

// ⚠️ Import side-effect: sniperMonitor arranca sus loops internos
import './sniperMonitor.js';

// 🧹 Limpiar/normalizar env primero
console.log('🚀 Starting Pump.fun SNIPER Bot Worker...\n');
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
    console.log(
      '❌ Worker Redis connection failed:',
      error?.message || String(error),
    );
    return;
  }

  const DRY_RUN = parseBoolEnv(process.env.DRY_RUN, true);
  const ENABLE_AUTO_TRADING = parseBoolEnv(
    process.env.ENABLE_AUTO_TRADING,
    true,
  );

  console.log('\n🎯 Pump.fun SNIPER Bot Config:');
  console.log(`   Mode: ${DRY_RUN ? '📄 PAPER (DRY_RUN)' : '💰 LIVE'}`);
  console.log(
    `   ENABLE_AUTO_TRADING: ${ENABLE_AUTO_TRADING ? 'ON' : 'OFF'}`,
  );
  console.log(
    `   POSITION_SIZE_SOL: ${process.env.POSITION_SIZE_SOL || '0.05'} SOL`,
  );
  console.log(
    `   MAX_POSITIONS: ${process.env.MAX_POSITIONS || '3'} (sniper strategy)`,
  );
  console.log(`   REQUIRE_TWITTER: ${process.env.REQUIRE_TWITTER || 'true'}`);
  console.log(
    `   MIN_BUNDLE_AMOUNT: ${process.env.MIN_BUNDLE_AMOUNT || '0.5'} SOL`,
  );
  console.log(`   REQUIRE_MOMENTUM: ${process.env.REQUIRE_MOMENTUM || 'true'}`);
  console.log(
    `   CANDLE_ANALYSIS_DELAY: ${
      (parseInt(process.env.CANDLE_ANALYSIS_DELAY_MS || '30000') / 1000).toFixed(0)
    }s`,
  );
  console.log(
    `   STOP_LOSS: ${
      parseBoolEnv(process.env.STOP_LOSS_ENABLED, true)
        ? `Enabled (-${process.env.SNIPER_STOP_LOSS || '20'}%)`
        : 'Disabled'
    }`,
  );
  console.log(
    `   TAKE_PROFIT: ${
      parseBoolEnv(process.env.TAKE_PROFIT_ENABLED, true)
        ? `Enabled (+${process.env.SNIPER_PROFIT_TARGET || '150'}%)`
        : 'Disabled'
    }`,
  );
  console.log(
    `   TRAILING_STOP: ${
      parseBoolEnv(process.env.TRAILING_STOP_ENABLED, true)
        ? `Enabled (-${process.env.SNIPER_TRAILING_STOP || '30'}%)`
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

    // 2) Sniper Strategy
    const sniperStrategy = getSniperStrategy();
    console.log('🎯 Sniper strategy loaded');

    // 3) Candle Analyzer
    const candleAnalyzer = getCandleAnalyzer();
    console.log('📊 Candle analyzer loaded');

    // 4) Graduation watcher
    const graduationHandler = startGraduationWatcher(redis);
    console.log('🎓 Graduation watcher started');

    // 5) Flintr WebSocket (escucha tokens nuevos)
    const flintrWs = startFlintrSniper(redis);
    if (!flintrWs) {
      console.log('⚠️ Flintr WebSocket not started (API key missing)');
      console.log('   Bot will not detect new tokens!\n');
    } else {
      console.log('🔥 Flintr WebSocket started (token detection active)');
    }

    // 6) sniperMonitor ya está corriendo por el import (loops internos)
    console.log('🧠 sniperMonitor loops are running (BUY/SELL logic + exits)');

    // 7) Stats periódicos
    const statsIntervalMs = parseInt(
      process.env.RISK_TICK_INTERVAL || '120000',
      10,
    );

    setInterval(async () => {
      try {
        const openPositions = await redis.scard('open_positions');
        const sniperSignals = await redis.llen('sniper_signals');

        console.log('\n📊 Worker Status (Sniper Bot):');
        console.log(`   Open Positions: ${openPositions}`);
        console.log(`   Sniper Signals in queue: ${sniperSignals}`);

        // Flintr stats
        const { getSniperStats } = await import('./flintrClient.js');
        const flintrStats = getSniperStats();
        console.log('   🔥 Flintr Stats:');
        console.log(`      Detected: ${flintrStats.tokensDetected}`);
        console.log(`      Filtered: ${flintrStats.tokensFiltered} (${flintrStats.filterRate})`);
        console.log(`      Sniped: ${flintrStats.tokensSniped} (${flintrStats.snipeRate})`);

        // Candle analyzer stats
        const candleStats = candleAnalyzer.getStats();
        console.log('   📊 Candle Analyzer:');
        console.log(`      Tokens tracked: ${candleStats.tokensTracked}`);
        console.log(`      Data points: ${candleStats.totalDataPoints}`);

        // Daily stats
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
        } catch {}

        console.log('');
      } catch {}
    }, statsIntervalMs);

    console.log('✅ Pump.fun SNIPER Worker is running');
    console.log('   Flintr → Redis(sniper_signals) → sniperMonitor + Candle Analysis\n');
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
    // Cerrar conexiones si es necesario
  } catch {}
  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// Iniciar el worker
startWorker();
