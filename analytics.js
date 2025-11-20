// analytics.js - Sistema de análisis de trading tipo Tradezella (compatible con RiskManager nuevo)
import IORedis from 'ioredis';

export class TradingAnalytics {
  /**
   * @param {import('ioredis').Redis} redis
   */
  constructor(redis) {
    this.redis = redis;
  }

  // ─────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────

  _toDateKey(date) {
    if (typeof date === 'string') return date.split('T')[0];
    return date.toISOString().split('T')[0];
  }

  _safeNumber(v, def = 0) {
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isFinite(n) ? n : def;
  }

  _groupBy(array, keyFn) {
    const map = new Map();
    for (const item of array) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  }

  // ─────────────────────────────────────────────────────
  // Carga de trades desde Redis
  // ─────────────────────────────────────────────────────

  /**
   * Obtiene todos los trades almacenados en Redis en el rango de fechas.
   * Lee las listas trades:YYYY-MM-DD (formato que guarda RiskManager.closePosition)
   *
   * @param {string|Date} startDate
   * @param {string|Date|null} endDate
   * @param {{strategy?: string|string[]}|undefined} options
   * @returns {Promise<Array<object>>}
   */
  async getTrades(startDate, endDate = null, options = {}) {
    try {
      const trades = [];
      const start = new Date(startDate);
      const end = endDate ? new Date(endDate) : new Date();

      const strategyFilter = options.strategy
        ? Array.isArray(options.strategy)
          ? options.strategy
          : [options.strategy]
        : null;

      const current = new Date(start);
      while (current <= end) {
        const key = `trades:${this._toDateKey(current)}`;
        const dayTrades = await this.redis.lrange(key, 0, -1);

        for (const raw of dayTrades) {
          try {
            const trade = JSON.parse(raw);

            // Normalizar campos críticos
            trade.entryTime = trade.entryTime
              ? Number(trade.entryTime)
              : null;
            trade.exitTime = trade.exitTime
              ? Number(trade.exitTime)
              : null;

            trade.entryPrice = this._safeNumber(trade.entryPrice);
            trade.exitPrice = this._safeNumber(trade.exitPrice);
            trade.solAmount = this._safeNumber(trade.solAmount);
            trade.solReceived = this._safeNumber(trade.solReceived);
            trade.pnlSOL = this._safeNumber(trade.pnlSOL);
            trade.pnlPercent = this._safeNumber(trade.pnlPercent);

            trade.strategy = trade.strategy || trade.entry_strategy || 'unknown';
            trade.reason = trade.reason || 'unknown';
            trade._dateKey = this._toDateKey(
              trade.exitTime ? new Date(trade.exitTime) : current,
            );

            if (
              strategyFilter &&
              !strategyFilter.includes(trade.strategy)
            ) {
              continue;
            }

            trades.push(trade);
          } catch {
            // Ignorar registros corruptos
          }
        }

        current.setDate(current.getDate() + 1);
      }

      // Ordenar por exitTime (si existe) o por _dateKey
      trades.sort((a, b) => {
        const ta = a.exitTime || 0;
        const tb = b.exitTime || 0;
        if (ta && tb) return ta - tb;
        if (ta && !tb) return -1;
        if (!ta && tb) return 1;
        return a._dateKey.localeCompare(b._dateKey);
      });

      return trades;
    } catch (error) {
      console.error('Error getting trades:', error.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────
  // Estadísticas generales (tipo Tradezella)
  // ─────────────────────────────────────────────────────

  /**
   * Stats globales de los últimos N días
   */
  async getOverallStats(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);
    const totalTrades = trades.length;

    if (!totalTrades) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: '0.00%',
        totalPnL: '0.000000',
        avgReturn: '0.00%',
        profitFactor: '0.00',
        biggestWin: '0.0000',
        biggestLoss: '0.0000',
        avgHoldTimeSec: 0,
      };
    }

    let wins = 0;
    let losses = 0;
    let totalPnL = 0;
    let sumReturn = 0;

    let sumPos = 0;
    let sumNeg = 0;

    let biggestWin = -Infinity;
    let biggestLoss = Infinity;

    let totalHoldSec = 0;
    let holdCount = 0;

    for (const t of trades) {
      const pnl = this._safeNumber(t.pnlSOL);
      const ret = this._safeNumber(t.pnlPercent);

      totalPnL += pnl;
      sumReturn += ret;

      if (pnl > 0) {
        wins++;
        sumPos += pnl;
        if (pnl > biggestWin) biggestWin = pnl;
      } else if (pnl < 0) {
        losses++;
        sumNeg += pnl;
        if (pnl < biggestLoss) biggestLoss = pnl;
      }

      if (t.entryTime && t.exitTime && t.exitTime > t.entryTime) {
        totalHoldSec += (t.exitTime - t.entryTime) / 1000;
        holdCount++;
      }
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgReturn = totalTrades > 0 ? sumReturn / totalTrades : 0;
    const profitFactor =
      sumNeg < 0 ? sumPos / Math.abs(sumNeg) : sumPos > 0 ? Infinity : 0;
    const avgHoldTimeSec = holdCount > 0 ? totalHoldSec / holdCount : 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate: `${winRate.toFixed(2)}%`,
      totalPnL: totalPnL.toFixed(6),
      avgReturn: `${avgReturn.toFixed(2)}%`,
      profitFactor:
        profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
      biggestWin:
        biggestWin === -Infinity ? '0.0000' : biggestWin.toFixed(4),
      biggestLoss:
        biggestLoss === Infinity ? '0.0000' : biggestLoss.toFixed(4),
      avgHoldTimeSec: Math.round(avgHoldTimeSec),
    };
  }

  // ─────────────────────────────────────────────────────
  // Resumen diario
  // ─────────────────────────────────────────────────────

  async getDailySummary(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);
    const grouped = this._groupBy(trades, (t) => t._dateKey);

    const results = [];
    for (const [day, dayTrades] of grouped.entries()) {
      let wins = 0;
      let losses = 0;
      let totalPnL = 0;
      let sumReturn = 0;

      for (const t of dayTrades) {
        const pnl = this._safeNumber(t.pnlSOL);
        const ret = this._safeNumber(t.pnlPercent);

        totalPnL += pnl;
        sumReturn += ret;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }

      const totalTrades = dayTrades.length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const avgReturn = totalTrades > 0 ? sumReturn / totalTrades : 0;

      results.push({
        date: day,
        totalTrades,
        wins,
        losses,
        winRate: `${winRate.toFixed(2)}%`,
        totalPnL: totalPnL.toFixed(4),
        avgReturn: `${avgReturn.toFixed(2)}%`,
      });
    }

    results.sort((a, b) => a.date.localeCompare(b.date));
    return results;
  }

  // ─────────────────────────────────────────────────────
  // Por estrategia
  // ─────────────────────────────────────────────────────

  async getByStrategy(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString());
    const grouped = this._groupBy(trades, (t) => t.strategy || 'unknown');

    const results = [];
    for (const [strategy, list] of grouped.entries()) {
      let wins = 0;
      let losses = 0;
      let totalPnL = 0;

      for (const t of list) {
        const pnl = this._safeNumber(t.pnlSOL);
        totalPnL += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }

      const totalTrades = list.length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const avgPnL = totalTrades > 0 ? totalPnL / totalTrades : 0;

      results.push({
        strategy,
        totalTrades,
        wins,
        losses,
        winRate: `${winRate.toFixed(2)}%`,
        avgPnL: avgPnL.toFixed(4),
        totalPnL: totalPnL.toFixed(4),
      });
    }

    results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));
    return results;
  }

  // ─────────────────────────────────────────────────────
  // Por token
  // ─────────────────────────────────────────────────────

  async getByToken(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);
    const grouped = this._groupBy(trades, (t) => t.mint || 'unknown');

    const results = [];
    for (const [mint, list] of grouped.entries()) {
      let wins = 0;
      let losses = 0;
      let totalPnL = 0;

      let symbol = null;

      for (const t of list) {
        const pnl = this._safeNumber(t.pnlSOL);
        totalPnL += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;

        if (!symbol) {
          symbol =
            t.symbol ||
            t.fl_intr_symbol ||
            t.fl_intr_name ||
            t.fl_intr_symbol ||
            null;
        }
      }

      const totalTrades = list.length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

      results.push({
        mint,
        symbol: symbol || mint.slice(0, 6),
        totalTrades,
        wins,
        losses,
        winRate: `${winRate.toFixed(2)}%`,
        totalPnL: totalPnL.toFixed(4),
      });
    }

    results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));
    return results;
  }

  // ─────────────────────────────────────────────────────
  // Por razón de salida (stop, TP, trailing, manual, etc.)
  // ─────────────────────────────────────────────────────

  async getByExitReason(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);
    const grouped = this._groupBy(trades, (t) => t.reason || 'unknown');

    const results = [];
    for (const [reason, list] of grouped.entries()) {
      let wins = 0;
      let losses = 0;
      let totalPnL = 0;

      for (const t of list) {
        const pnl = this._safeNumber(t.pnlSOL);
        totalPnL += pnl;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }

      const totalTrades = list.length;
      const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
      const avgPnL = totalTrades > 0 ? totalPnL / totalTrades : 0;

      results.push({
        reason,
        totalTrades,
        wins,
        losses,
        winRate: `${winRate.toFixed(2)}%`,
        avgPnL: avgPnL.toFixed(4),
        totalPnL: totalPnL.toFixed(4),
      });
    }

    results.sort((a, b) => parseFloat(b.totalPnL) - parseFloat(a.totalPnL));
    return results;
  }

  // ─────────────────────────────────────────────────────
  // Curva de equity
  // ─────────────────────────────────────────────────────

  async getEquityCurve(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);
    let equity = 0;
    const points = [];

    for (const t of trades) {
      equity += this._safeNumber(t.pnlSOL);
      const time = t.exitTime || t.entryTime || Date.now();
      points.push({
        time,
        equity: Number(equity.toFixed(6)),
      });
    }

    return points;
  }

  // ─────────────────────────────────────────────────────
  // Exportar CSV (para Tradezella / Notion / Excel)
  // ─────────────────────────────────────────────────────

  async exportCSV(days = 30, options = {}) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const trades = await this.getTrades(startDate.toISOString(), null, options);

    let csv =
      'date,mint,symbol,strategy,side,entryTime,exitTime,entryPrice,exitPrice,solAmount,solReceived,pnlSOL,pnlPercent,reason,holdSeconds\n';

    for (const t of trades) {
      const date = t._dateKey || this._toDateKey(new Date());
      const symbol =
        t.symbol ||
        t.flintr_symbol ||
        t.flintr_name ||
        t.mint?.slice(0, 6) ||
        '';
      const side = t.side || (this._safeNumber(t.pnlSOL) >= 0 ? 'LONG' : 'LONG');

      const entryTimeStr = t.entryTime
        ? new Date(t.entryTime).toISOString()
        : '';
      const exitTimeStr = t.exitTime
        ? new Date(t.exitTime).toISOString()
        : '';

      const holdSeconds =
        t.entryTime && t.exitTime && t.exitTime > t.entryTime
          ? ((t.exitTime - t.entryTime) / 1000).toFixed(0)
          : '';

      csv += `${date},`;
      csv += `${t.mint || ''},`;
      csv += `${symbol},`;
      csv += `${t.strategy || t.entry_strategy || ''},`;
      csv += `${side},`;
      csv += `${entryTimeStr},`;
      csv += `${exitTimeStr},`;
      csv += `${this._safeNumber(t.entryPrice).toFixed(10)},`;
      csv += `${this._safeNumber(t.exitPrice).toFixed(10)},`;
      csv += `${this._safeNumber(t.solAmount).toFixed(4)},`;
      csv += `${this._safeNumber(t.solReceived).toFixed(4)},`;
      csv += `${this._safeNumber(t.pnlSOL).toFixed(4)},`;
      csv += `${this._safeNumber(t.pnlPercent).toFixed(2)},`;
      csv += `${t.reason || 'unknown'},`;
      csv += `${holdSeconds}\n`;
    }

    return csv;
  }

  // ─────────────────────────────────────────────────────
  // Reporte completo por consola (para debug rápido)
  // ─────────────────────────────────────────────────────

  async generateFullReport(days = 30, options = {}) {
    console.log(`\n📊 ========== TRADING REPORT (Last ${days} days) ==========\n`);

    const overall = await this.getOverallStats(days, options);
    console.log('📈 OVERALL PERFORMANCE:');
    console.log(`   Total Trades: ${overall.totalTrades}`);
    console.log(
      `   Win Rate: ${overall.winRate} (${overall.wins}W / ${overall.losses}L)`,
    );
    console.log(`   Total P&L: ${overall.totalPnL} SOL`);
    console.log(`   Avg Return: ${overall.avgReturn}`);
    console.log(`   Profit Factor: ${overall.profitFactor}`);
    console.log(
      `   Biggest Win: ${overall.biggestWin} SOL | Biggest Loss: ${overall.biggestLoss} SOL`,
    );
    console.log(
      `   Avg Hold Time: ${overall.avgHoldTimeSec}s (~${(
        overall.avgHoldTimeSec / 60
      ).toFixed(1)} min)\n`,
    );

    const daily = await this.getDailySummary(days, options);
    console.log('📅 DAILY SUMMARY:');
    for (const d of daily) {
      console.log(
        `   ${d.date} | Trades: ${d.totalTrades} | WinRate: ${d.winRate} | P&L: ${d.totalPnL} SOL`,
      );
    }

    const byReason = await this.getByExitReason(days, options);
    console.log('\n🎯 BY EXIT REASON:');
    for (const r of byReason) {
      console.log(
        `   ${r.reason} → Trades: ${r.totalTrades}, WinRate: ${r.winRate}, Total P&L: ${r.totalPnL} SOL`,
      );
    }

    const byStrat = await this.getByStrategy(days);
    console.log('\n🧠 BY STRATEGY:');
    for (const s of byStrat) {
      console.log(
        `   ${s.strategy} → Trades: ${s.totalTrades}, WinRate: ${s.winRate}, Total P&L: ${s.totalPnL} SOL`,
      );
    }

    console.log('\n✅ End of report.\n');
  }
}
