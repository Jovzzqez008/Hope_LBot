// sniperStrategy.js - Estrategia de entrada/salida para SNIPER
// ✅ Decide cuándo entrar basado en filtros + momentum
// ✅ Stops, TP y trailing configurables
// ✅ Usa análisis de velas en tiempo real

import IORedis from 'ioredis';
import { getCandleAnalyzer } from './candleAnalyzer.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
});

const candleAnalyzer = getCandleAnalyzer();

function parseNumber(value, defaultValue) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : defaultValue;
}

function parseBool(value, defaultValue = false) {
  const v = (value || '').toString().trim().toLowerCase();
  if (!v) return defaultValue;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export class SniperStrategy {
  constructor() {
    // Trading config
    this.enableAutoTrading = parseBool(process.env.ENABLE_AUTO_TRADING, true);
    this.positionSizeSol = parseNumber(process.env.POSITION_SIZE_SOL, 0.05);
    this.maxPositions = parseNumber(process.env.MAX_POSITIONS, 3);

    // Filtros de entrada
    this.requireTwitter = parseBool(process.env.REQUIRE_TWITTER, true);
    this.minBundleAmount = parseNumber(process.env.MIN_BUNDLE_AMOUNT, 0.5);
    this.requireMomentum = parseBool(process.env.REQUIRE_MOMENTUM, true);
    this.minMomentumIntervals = parseNumber(process.env.MIN_MOMENTUM_INTERVALS, 2);

    // Análisis de velas (delay para acumular datos)
    this.candleAnalysisDelay = parseNumber(
      process.env.CANDLE_ANALYSIS_DELAY_MS,
      30000, // 30s default
    );

    // Stops y TP
    this.stopLossPercent = parseNumber(
      process.env.SNIPER_STOP_LOSS || process.env.STOP_LOSS_PERCENT,
      20,
    );
    this.takeProfitPercent = parseNumber(
      process.env.SNIPER_PROFIT_TARGET || process.env.TAKE_PROFIT_PERCENT,
      150,
    );
    this.trailingStopPercent = parseNumber(
      process.env.SNIPER_TRAILING_STOP || process.env.TRAILING_STOP_PERCENT,
      30,
    );

    this.stopLossEnabled = parseBool(process.env.STOP_LOSS_ENABLED, true);
    this.takeProfitEnabled = parseBool(process.env.TAKE_PROFIT_ENABLED, true);
    this.trailingStopEnabled = parseBool(process.env.TRAILING_STOP_ENABLED, true);

    // Tiempo máximo de hold
    this.maxHoldMinutes = parseNumber(
      process.env.SNIPER_MAX_HOLD_MINUTES || process.env.MAX_HOLD_MINUTES,
      60,
    );

    console.log('🎯 SniperStrategy initialized');
    console.log(`   Position size: ${this.positionSizeSol} SOL`);
    console.log(`   Max positions: ${this.maxPositions}`);
    console.log(`   Require Twitter: ${this.requireTwitter}`);
    console.log(`   Require Momentum: ${this.requireMomentum}`);
    console.log(`   Candle delay: ${this.candleAnalysisDelay / 1000}s`);
    console.log(`   Stop Loss: ${this.stopLossEnabled ? this.stopLossPercent + '%' : 'OFF'}`);
    console.log(`   Take Profit: ${this.takeProfitEnabled ? this.takeProfitPercent + '%' : 'OFF'}`);
    console.log(`   Trailing Stop: ${this.trailingStopEnabled ? this.trailingStopPercent + '%' : 'OFF'}`);
  }

  /**
   * Decide si debe entrar (snipear) un token
   */
  async shouldSnipe(signal) {
    if (!this.enableAutoTrading) {
      return {
        snipe: false,
        reason: 'auto_trading_disabled',
      };
    }

    if (!signal || !signal.mint) {
      return {
        snipe: false,
        reason: 'invalid_signal',
      };
    }

    const { mint, twitter, bundleAmount } = signal;

    // 1) Verificar Twitter
    if (this.requireTwitter && (!twitter || !twitter.includes('x.com'))) {
      return {
        snipe: false,
        reason: 'no_twitter',
      };
    }

    // 2) Verificar bundle mínimo
    if (bundleAmount < this.minBundleAmount) {
      return {
        snipe: false,
        reason: 'bundle_too_low',
        bundleAmount,
        minRequired: this.minBundleAmount,
      };
    }

    // 3) Verificar cooldown (no re-entrar al mismo token)
    const cooldown = await redis.get(`sniper_cooldown:${mint}`);
    if (cooldown) {
      return {
        snipe: false,
        reason: 'cooldown_active',
      };
    }

    // 4) Verificar que no tengamos posición abierta
    const alreadyOpen = await redis.sismember('open_positions', mint);
    if (alreadyOpen) {
      return {
        snipe: false,
        reason: 'already_in_position',
      };
    }

    // 5) Verificar límite de posiciones
    try {
      const openCount = await redis.scard('open_positions');
      if (openCount >= this.maxPositions) {
        return {
          snipe: false,
          reason: 'max_positions_reached',
        };
      }
    } catch {}

    // 6) Análisis de momentum (si está habilitado)
    if (this.requireMomentum) {
      // Esperar un tiempo para acumular datos de precio
      const tokenAge = Date.now() - (signal.timestamp || Date.now());
      
      if (tokenAge < this.candleAnalysisDelay) {
        return {
          snipe: false,
          reason: 'waiting_for_candle_data',
          waitTime: this.candleAnalysisDelay - tokenAge,
        };
      }

      const momentumCheck = await candleAnalyzer.shouldSnipe(mint);
      
      if (!momentumCheck.snipe) {
        return {
          snipe: false,
          reason: momentumCheck.reason,
          analysis: momentumCheck.analysis,
        };
      }

      console.log(`   ✅ Momentum detected: ${momentumCheck.signals?.join(', ')}`);
    }

    // ✅ Todas las condiciones cumplidas
    return {
      snipe: true,
      reason: 'filters_passed',
      amount: this.positionSizeSol,
      confidence: 85, // Confianza base para sniper
    };
  }

  /**
   * Decide si debe salir de una posición
   */
  async shouldExit(position, currentPrice) {
    if (!position || !position.mint || !currentPrice) {
      return {
        exit: false,
        reason: 'invalid_position',
      };
    }

    const strategy = position.strategy || position.entry_strategy || 'sniper';
    if (strategy !== 'sniper') {
      return {
        exit: false,
        reason: 'not_sniper_strategy',
      };
    }

    const entryPrice = parseNumber(position.entryPrice, 0);
    if (!entryPrice || entryPrice <= 0) {
      return {
        exit: false,
        reason: 'no_entry_price',
      };
    }

    const entryTime = parseNumber(position.entryTime, 0);
    const now = Date.now();

    // PnL %
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Trailing stop: maxPrice se actualiza en sniperMonitor
    const maxPrice = parseNumber(position.maxPrice, entryPrice);
    const drawdownPercent =
      maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;

    // 1) TAKE PROFIT
    if (this.takeProfitEnabled && this.takeProfitPercent > 0) {
      if (pnlPercent >= this.takeProfitPercent) {
        return {
          exit: true,
          reason: 'take_profit',
          description: `Reached target: ${pnlPercent.toFixed(
            2,
          )}% ≥ ${this.takeProfitPercent}%`,
          priority: 3,
        };
      }
    }

    // 2) TRAILING STOP
    if (this.trailingStopEnabled && this.trailingStopPercent > 0) {
      if (drawdownPercent <= -this.trailingStopPercent) {
        return {
          exit: true,
          reason: 'trailing_stop',
          description: `Pulled back ${-drawdownPercent.toFixed(
            2,
          )}% from max, threshold: ${this.trailingStopPercent}%`,
          priority: 3,
        };
      }
    }

    // 3) STOP LOSS
    if (this.stopLossEnabled && this.stopLossPercent > 0) {
      if (pnlPercent <= -this.stopLossPercent) {
        return {
          exit: true,
          reason: 'stop_loss',
          description: `Hit stop loss: ${pnlPercent.toFixed(
            2,
          )}% ≤ -${this.stopLossPercent}%`,
          priority: 4,
        };
      }
    }

    // 4) Tiempo máximo de hold
    if (this.maxHoldMinutes > 0 && entryTime > 0) {
      const holdMinutes = (now - entryTime) / 60000;
      if (holdMinutes >= this.maxHoldMinutes) {
        return {
          exit: true,
          reason: 'max_hold_time',
          description: `Exceeded max hold: ${holdMinutes.toFixed(
            1,
          )} min ≥ ${this.maxHoldMinutes} min`,
          priority: 5,
        };
      }
    }

    return {
      exit: false,
      reason: 'hold',
      description: 'Conditions not met',
    };
  }
}

// Singleton
let strategyInstance = null;

export function getSniperStrategy() {
  if (!strategyInstance) {
    strategyInstance = new SniperStrategy();
  }
  return strategyInstance;
}

console.log('🎯 sniperStrategy.js loaded');
