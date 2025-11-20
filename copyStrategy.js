// copyStrategy.js - Smart Copy Trading Strategy (solo COPY TRADING)

import IORedis from 'ioredis';

const redis =
  process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryDelayOnFailover: 100,
      })
    : null;

function parseNumber(value, defaultValue) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : defaultValue;
}

function parseBool(value, defaultValue = false) {
  const v = (value || '').toString().trim().toLowerCase();
  if (!v) return defaultValue;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export class CopyStrategy {
  constructor() {
    // Configuración de entradas (ENV)
    this.enableAutoTrading = parseBool(process.env.ENABLE_AUTO_TRADING, true);

    this.positionSizeSol = parseNumber(process.env.POSITION_SIZE_SOL, 0.05);
    this.maxPositions = parseNumber(process.env.MAX_POSITIONS, 2);

    this.minWalletsToBuy = parseNumber(process.env.MIN_WALLETS_TO_BUY, 1);
    this.minWalletsToSell = parseNumber(process.env.MIN_WALLETS_TO_SELL, 1);

    // Stops / TP / Trailing (copy-specific primero, luego genérico)
    this.stopLossPercent = parseNumber(
      process.env.COPY_STOP_LOSS ?? process.env.STOP_LOSS_PERCENT,
      25,
    );
    this.takeProfitPercent = parseNumber(
      process.env.COPY_PROFIT_TARGET ?? process.env.TAKE_PROFIT_PERCENT,
      200,
    );
    this.trailingStopPercent = parseNumber(
      process.env.TRAILING_STOP ?? process.env.TRAILING_STOP_PERCENT,
      35,
    );

    this.stopLossEnabled = parseBool(
      process.env.STOP_LOSS_ENABLED,
      true,
    );
    this.takeProfitEnabled = parseBool(
      process.env.TAKE_PROFIT_ENABLED,
      true,
    );
    this.trailingStopEnabled = parseBool(
      process.env.TRAILING_STOP_ENABLED,
      true,
    );

    // Tiempo máximo de hold (independiente de hybrid)
    this.maxHoldMinutes = parseNumber(
      process.env.MAX_HOLD_MINUTES ?? process.env.COPY_MAX_HOLD_MINUTES,
      90,
    );
  }

  // ─────────────────────────────────────────────────────
  // shouldCopy: decide si copiamos una señal de BUY
  // ─────────────────────────────────────────────────────

  /**
   * @param {object} signal
   * {
   *   walletAddress,
   *   walletName,
   *   mint,
   *   originalAmount,
   *   copyAmount,
   *   signature,
   *   timestamp,
   *   upvotes,
   *   buyers,
   *   reason,
   *   dex
   * }
   */
  async shouldCopy(signal) {
    if (!this.enableAutoTrading) {
      return {
        copy: false,
        reason: 'auto_trading_disabled',
      };
    }

    if (!signal || !signal.mint) {
      return {
        copy: false,
        reason: 'invalid_signal',
      };
    }

    const mint = signal.mint;
    const upvotes = parseNumber(signal.upvotes, 1);

    // 1) Verificar mínimo de wallets comprando
    if (upvotes < this.minWalletsToBuy) {
      return {
        copy: false,
        reason: 'not_enough_upvotes',
        upvotes,
        buyers: signal.buyers || [],
      };
    }

    // 2) Verificar cooldown (para no entrar múltiples veces al mismo token)
    if (redis) {
      const cooldown = await redis.get(`copy_cooldown:${mint}`);
      if (cooldown) {
        return {
          copy: false,
          reason: 'cooldown_active',
        };
      }
    }

    // 3) Verificar que no tengamos ya posición en ese token
    if (redis) {
      const alreadyOpen = await redis.sismember('open_positions', mint);
      if (alreadyOpen) {
        return {
          copy: false,
          reason: 'already_in_position',
        };
      }

      // 4) Verificar límite de posiciones abiertas
      try {
        const openCount = await redis.scard('open_positions');
        if (openCount >= this.maxPositions) {
          return {
            copy: false,
            reason: 'max_positions_reached',
          };
        }
      } catch {
        // Si falla Redis, ignoramos este check para no romper la lógica
      }

      // 5) Evitar reentradas justo después de un force_exit (graduación)
      const forceExitFlag = await redis.get(`force_exit:${mint}`);
      if (forceExitFlag) {
        return {
          copy: false,
          reason: 'recent_force_exit',
        };
      }
    }

    // 6) Definir confianza basada en número de wallets
    let confidence = 50;
    if (upvotes <= 1) confidence = 55;
    else if (upvotes === 2) confidence = 70;
    else if (upvotes === 3) confidence = 80;
    else confidence = 90;
    if (confidence > 95) confidence = 95;

    // 7) Modo de copia: usamos siempre POSITION_SIZE_SOL (ya viene en signal.copyAmount)
    const amount = parseNumber(signal.copyAmount, this.positionSizeSol);

    if (amount <= 0) {
      return {
        copy: false,
        reason: 'invalid_copy_amount',
        upvotes,
        buyers: signal.buyers || [],
      };
    }

    return {
      copy: true,
      mode: 'copy_trade',
      amount,
      upvotes,
      buyers: signal.buyers || [],
      confidence,
      reason: 'upvotes_ok',
    };
  }

  // ─────────────────────────────────────────────────────
  // shouldExit: lógica de SL / TP / Trailing / tiempo
  // ─────────────────────────────────────────────────────

  /**
   * @param {object} position - registro de la posición (position:<mint>)
   * @param {number} currentPrice - precio actual (bonding curve / Jupiter)
   */
  async shouldExit(position, currentPrice) {
    if (!position || !position.mint || !currentPrice) {
      return {
        exit: false,
        reason: 'invalid_position',
      };
    }

    // Sólo aplicamos a estrategia de copy
    const strategy = position.strategy || position.entry_strategy || 'copy';
    if (strategy !== 'copy') {
      return {
        exit: false,
        reason: 'not_copy_strategy',
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

    // Trailing stop: maxPrice se actualiza en copyMonitor
    const maxPrice = parseNumber(position.maxPrice, entryPrice);
    const drawdownPercent =
      maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;

    // 1) TAKE PROFIT
    if (this.takeProfitEnabled && this.takeProfitPercent > 0) {
      if (pnlPercent >= this.takeProfitPercent) {
        return {
          exit: true,
          reason: 'take_profit',
          description: `Reached target profit: ${pnlPercent.toFixed(
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
          description: `Price pulled back ${
            -drawdownPercent
          }% from max, threshold: ${this.trailingStopPercent}%`,
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

    // 4) Tiempo máximo de hold (fallback global)
    if (this.maxHoldMinutes > 0 && entryTime > 0) {
      const holdMinutes = (now - entryTime) / 60000;
      if (holdMinutes >= this.maxHoldMinutes) {
        return {
          exit: true,
          reason: 'max_hold_time',
          description: `Exceeded max hold time: ${holdMinutes.toFixed(
            1,
          )} min ≥ ${this.maxHoldMinutes} min`,
          priority: 5,
        };
      }
    }

    // Nada dispara salida
    return {
      exit: false,
      reason: 'hold',
      description: 'Conditions not met (SL/TP/TS/Time)',
    };
  }
}
