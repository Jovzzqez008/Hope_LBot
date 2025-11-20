// riskManager.js - Gestión de riesgo + P&L unificado (Copy + Sniper compatible)

import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';

const REDIS_URL = process.env.REDIS_URL || null;

// Helpers de tiempo
function formatDateKey(date = new Date()) {
  // YYYY-MM-DD en zona "servidor" (no importa que sea UTC o local, solo que sea consistente)
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Convierte string a número seguro
function toNumber(value, def = 0) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return def;
  return n;
}

// ═══════════════════════════════════════════════════════
// PositionManager: CRUD de posiciones en Redis
// ═══════════════════════════════════════════════════════

export class PositionManager {
  constructor(redis) {
    if (!redis && !REDIS_URL) {
      throw new Error('Redis no configurado en PositionManager');
    }

    this.redis =
      redis ||
      new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
      });

    this.indexKey = 'open_positions'; // set con los mints de posiciones abiertas
  }

  async openPosition(position) {
    const {
      mint,
      symbol = '',
      entryPrice,
      solAmount,
      tokensAmount,
      wallet = '',
      entryStrategy = 'copy',
      source = 'copy_trading',
      txId = '',
      extra = {},
    } = position;

    if (!mint) {
      throw new Error('openPosition requiere mint');
    }

    const nowMs = Date.now();

    const key = `position:${mint}`;
    const data = {
      mint,
      symbol,
      entryPrice: String(entryPrice ?? '0'),
      solAmount: String(solAmount ?? '0'),
      tokensAmount: String(tokensAmount ?? '0'),
      wallet,
      entry_strategy: entryStrategy,
      source,
      txId,
      status: 'open',
      entryTime: String(nowMs),
      maxPrice: String(entryPrice ?? '0'),
      lastUpdate: String(nowMs),
      ...Object.fromEntries(
        Object.entries(extra || {}).map(([k, v]) => [k, String(v)]),
      ),
    };

    await this.redis.multi().sadd(this.indexKey, mint).hset(key, data).exec();
    return data;
  }

  async updatePosition(mint, updates) {
    if (!mint || !updates || Object.keys(updates).length === 0) return;

    const key = `position:${mint}`;
    const nowMs = Date.now();

    const data = {
      ...Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [k, String(v)]),
      ),
      lastUpdate: String(nowMs),
    };

    await this.redis.hset(key, data);
  }

  async closePosition(mint, closeInfo = {}) {
    if (!mint) {
      throw new Error('closePosition requiere mint');
    }

    const key = `position:${mint}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    const entryPrice = toNumber(raw.entryPrice);
    const solAmount = toNumber(raw.solAmount);
    const tokensAmount = toNumber(raw.tokensAmount);

    const exitPrice = toNumber(
      closeInfo.exitPrice ??
        closeInfo.price ??
        closeInfo.marketPrice ??
        entryPrice,
    );

    const exitSol =
      tokensAmount > 0 && exitPrice > 0 ? tokensAmount * exitPrice : solAmount;

    const pnlSol = exitSol - solAmount;
    const pnlPercent =
      entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

    const nowMs = Date.now();

    const updates = {
      status: 'closed',
      exitPrice: String(exitPrice),
      exitSol: String(exitSol),
      pnlSol: String(pnlSol),
      pnlPercent: String(pnlPercent),
      closeReason: closeInfo.reason || 'unknown',
      closeTxId: closeInfo.txId || '',
      closedAt: String(nowMs),
      lastUpdate: String(nowMs),
    };

    await this.redis
      .multi()
      .hset(key, updates)
      .srem(this.indexKey, mint)
      .exec();

    // Registrar trade cerrado en el "journal" diario
    const tradeRecord = {
      mint,
      symbol: raw.symbol || '',
      wallet: raw.wallet || '',
      entry_strategy: raw.entry_strategy || raw.strategy || 'unknown',
      source: raw.source || 'unknown',
      entryPrice,
      entrySol: solAmount,
      tokensAmount,
      exitPrice,
      exitSol,
      pnlSol,
      pnlPercent,
      entryTime: toNumber(raw.entryTime),
      closedAt: nowMs,
      closeReason: updates.closeReason,
      txIdOpen: raw.txId || '',
      txIdClose: updates.closeTxId,
    };

    const dateKey = formatDateKey(new Date(nowMs));
    const listKey = `trades:${dateKey}`;
    await this.redis.rpush(listKey, JSON.stringify(tradeRecord));

    return tradeRecord;
  }

  async getPosition(mint) {
    if (!mint) return null;
    const key = `position:${mint}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;

    return this._normalizePosition(raw);
  }

  async getOpenPositions() {
    const mints = await this.redis.smembers(this.indexKey);
    if (!mints || mints.length === 0) return [];

    const pipeline = this.redis.multi();
    for (const mint of mints) {
      pipeline.hgetall(`position:${mint}`);
    }
    const results = await pipeline.exec();

    const positions = [];
    for (const [index, res] of results.entries()) {
      const [, raw] = res;
      if (!raw || Object.keys(raw).length === 0) continue;
      positions.push(this._normalizePosition(raw));
    }

    return positions;
  }

  _normalizePosition(raw) {
    const entryPrice = toNumber(raw.entryPrice);
    const solAmount = toNumber(raw.solAmount);
    const tokensAmount = toNumber(raw.tokensAmount);
    const maxPrice = toNumber(raw.maxPrice);

    let pnlSol = toNumber(raw.pnlSol, 0);
    let pnlPercent = toNumber(raw.pnlPercent, 0);
    const status = raw.status || 'open';

    if (status === 'open' && pnlSol === 0 && pnlPercent === 0) {
      // P&L se calcula en otro lado (PriceService + analytics),
      // aquí lo dejamos como 0 por defecto.
    }

    return {
      mint: raw.mint,
      symbol: raw.symbol || '',
      wallet: raw.wallet || '',
      entry_strategy: raw.entry_strategy || raw.strategy || 'unknown',
      source: raw.source || 'unknown',
      status,
      entryPrice,
      solAmount,
      tokensAmount,
      entryTime: toNumber(raw.entryTime, 0),
      maxPrice,
      exitPrice: toNumber(raw.exitPrice, 0),
      exitSol: toNumber(raw.exitSol, 0),
      pnlSol,
      pnlPercent,
      closeReason: raw.closeReason || '',
      txIdOpen: raw.txId || '',
      txIdClose: raw.closeTxId || '',
      lastUpdate: toNumber(raw.lastUpdate, 0),
    };
  }
}

// ═══════════════════════════════════════════════════════
// RiskManager: reglas de riesgo + P&L diario
// ═══════════════════════════════════════════════════════

export class RiskManager {
  constructor(config = {}, redis) {
    if (!redis && !REDIS_URL) {
      throw new Error('Redis no configurado en RiskManager');
    }

    this.redis =
      redis ||
      new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
      });

    this.maxPositionSize = toNumber(
      config.maxPositionSize || process.env.POSITION_SIZE_SOL,
      0.05,
    );
    this.maxActivePositions = parseInt(
      config.maxActivePositions || process.env.MAX_POSITIONS || '2',
      10,
    );
    this.reservedFlintrPositions = parseInt(
      config.reservedFlintrPositions ||
        process.env.RESERVED_FLINTR_POSITIONS ||
        '0',
      10,
    );
    this.stopLossPercent = toNumber(
      config.stopLoss || process.env.STOP_LOSS_PERCENT,
      13,
    );
    this.takeProfitPercent = toNumber(
      config.takeProfit || process.env.TAKE_PROFIT_PERCENT,
      30,
    );
    this.minLiquiditySOL = toNumber(
      config.minLiquidity || process.env.MIN_LIQUIDITY_SOL,
      8,
    );
    this.minInitialVolumeSOL = toNumber(
      config.minInitialVolume || process.env.MIN_INITIAL_VOLUME_SOL,
      0,
    );
    this.maxDailyLossSol = toNumber(
      config.maxDailyLossSOL ||
        config.maxDailyLoss ||
        process.env.MAX_DAILY_LOSS_SOL,
      0,
    );
    this.enableLogs = !!config.enableRiskManagerLogs;

    this.positionManager = new PositionManager(this.redis);
    this.priceService = getPriceService();
  }

  static createFromEnv(redis) {
    const config = {
      maxPositionSize: process.env.POSITION_SIZE_SOL,
      maxActivePositions: process.env.MAX_POSITIONS,
      reservedFlintrPositions: process.env.RESERVED_FLINTR_POSITIONS,
      stopLoss: process.env.STOP_LOSS_PERCENT,
      takeProfit: process.env.TAKE_PROFIT_PERCENT,
      minLiquidity: process.env.MIN_LIQUIDITY_SOL,
      minInitialVolume: process.env.MIN_INITIAL_VOLUME_SOL,
      maxDailyLossSOL: process.env.MAX_DAILY_LOSS_SOL,
      enableRiskManagerLogs:
        (process.env.ENABLE_RISK_MANAGER_LOGS || '').trim().toLowerCase() ===
        'true',
    };

    return new RiskManager(config, redis);
  }

  // ──────────────────────────────────────────────────────
  // P&L diario (realizado)
  // ──────────────────────────────────────────────────────

  async getDailyPnL(dateKey = null) {
    const stats = await this.getDailyStats(dateKey);
    if (!stats) return 0;
    return stats.totalPnL;
  }

  async getDailyStats(dateKey = null) {
    const key = dateKey || formatDateKey(new Date());
    const listKey = `trades:${key}`;

    const entries = await this.redis.lrange(listKey, 0, -1);
    if (!entries || entries.length === 0) {
      return {
        date: key,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: '0.00%',
        totalPnL: 0,
        avgPnL: 0,
        biggestWin: 0,
        biggestLoss: 0,
        profitFactor: 0,
      };
    }

    let totalPnL = 0;
    let wins = 0;
    let losses = 0;
    let biggestWin = 0;
    let biggestLoss = 0;

    const trades = [];

    for (const entry of entries) {
      try {
        const t = JSON.parse(entry);
        const pnl = toNumber(t.pnlSol, 0);
        totalPnL += pnl;
        trades.push(pnl);

        if (pnl > 0) {
          wins++;
          if (pnl > biggestWin) biggestWin = pnl;
        } else if (pnl < 0) {
          losses++;
          if (pnl < biggestLoss) biggestLoss = pnl;
        }
      } catch {
        // ignorar entradas corruptas
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0;

    const grossProfit = trades.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const grossLoss = trades.filter((p) => p < 0).reduce((a, b) => a + b, 0);
    const profitFactor =
      grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : 0;

    const stats = {
      date: key,
      totalTrades,
      wins,
      losses,
      winRate: `${winRate.toFixed(2)}%`,
      totalPnL: Number(totalPnL.toFixed(4)),
      avgPnL: Number(avgPnL.toFixed(4)),
      biggestWin: Number(biggestWin.toFixed(4)),
      biggestLoss: Number(biggestLoss.toFixed(4)),
      profitFactor: Number(profitFactor.toFixed(3)),
    };

    if (this.enableLogs) {
      console.log('\n📊 RiskManager Daily Stats:');
      console.log(`   Date: ${stats.date}`);
      console.log(
        `   Trades: ${stats.totalTrades} | Wins: ${stats.wins} | Losses: ${stats.losses}`,
      );
      console.log(`   WinRate: ${stats.winRate}`);
      console.log(
        `   PnL: ${stats.totalPnL} SOL (Avg: ${stats.avgPnL} SOL, PF: ${stats.profitFactor})`,
      );
      console.log(
        `   Best: ${stats.biggestWin} SOL | Worst: ${stats.biggestLoss} SOL`,
      );
    }

    return stats;
  }

  // ──────────────────────────────────────────────────────
  // P&L no realizado (posiciones abiertas)
  // ──────────────────────────────────────────────────────

  async getOpenPnL() {
    const positions = await this.positionManager.getOpenPositions();
    if (!positions || positions.length === 0) {
      return {
        totalPnL: 0,
        totalPnLPercent: 0,
        totalSolNow: 0,
        totalSolEntry: 0,
        positions: [],
      };
    }

    const resultPositions = [];
    let totalEntrySol = 0;
    let totalNowSol = 0;

    for (const pos of positions) {
      const { mint, entryPrice, solAmount, tokensAmount } = pos;
      totalEntrySol += solAmount;

      const valueData = await this.priceService.calculateCurrentValue(
        mint,
        tokensAmount,
      );

      if (!valueData) {
        resultPositions.push({
          ...pos,
          currentPrice: 0,
          currentSol: solAmount,
          pnlSol: 0,
          pnlPercent: 0,
        });
        totalNowSol += solAmount;
        continue;
      }

      const currentPrice = valueData.marketPrice;
      const currentSol = valueData.solValue;
      const pnlSol = currentSol - solAmount;
      const pnlPercent =
        entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      totalNowSol += currentSol;

      resultPositions.push({
        ...pos,
        currentPrice,
        currentSol,
        pnlSol: Number(pnlSol.toFixed(4)),
        pnlPercent: Number(pnlPercent.toFixed(2)),
        graduated: valueData.graduated,
        priceSource: valueData.source,
      });
    }

    const totalPnL = totalNowSol - totalEntrySol;
    const totalPnLPercent =
      totalEntrySol > 0 ? (totalPnL / totalEntrySol) * 100 : 0;

    return {
      totalPnL: Number(totalPnL.toFixed(4)),
      totalPnLPercent: Number(totalPnLPercent.toFixed(2)),
      totalSolNow: Number(totalNowSol.toFixed(4)),
      totalSolEntry: Number(totalEntrySol.toFixed(4)),
      positions: resultPositions,
    };
  }

  // ──────────────────────────────────────────────────────
  // Reglas de entrada (usado por sniperEngine; para copy
  // trading tu riesgo principal está en copyStrategy.js)
  // ──────────────────────────────────────────────────────

  async shouldEnterTrade(mint, entryPrice, signals = {}) {
    const { tokenScore, safetyScore } = signals;

    // 1) Limitar número de posiciones abiertas totales
    const openPositions = await this.positionManager.getOpenPositions();
    const totalOpen = openPositions.length;

    if (this.maxActivePositions > 0 && totalOpen >= this.maxActivePositions) {
      return { allowed: false, reason: 'max_active_positions' };
    }

    // 2) Evitar repetidos en el mismo mint
    if (openPositions.some((p) => p.mint === mint)) {
      return { allowed: false, reason: 'already_in_position' };
    }

    // 3) Checar pérdidas diarias (realizadas)
    if (this.maxDailyLossSol > 0) {
      const dailyPnL = await this.getDailyPnL();
      if (dailyPnL < -this.maxDailyLossSol) {
        return { allowed: false, reason: 'max_daily_loss' };
      }
    }

    // 4) Filtro sencillo por "calidad" (si lo usas en sniper)
    if (typeof tokenScore === 'number' && tokenScore < 0) {
      return { allowed: false, reason: 'low_token_score' };
    }

    if (typeof safetyScore === 'number' && safetyScore < 0) {
      return { allowed: false, reason: 'low_safety_score' };
    }

    return { allowed: true, reason: 'ok' };
  }
}

console.log('✅ riskManager.js loaded');
