// candleAnalyzer.js - Análisis de velas para detectar momentum
// ✅ Calcula % de subida en períodos de tiempo
// ✅ Detecta tokens con movimiento alcista fuerte
// ✅ Usa precios reales del RPC (bonding curve)

import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
});

const priceService = getPriceService();

// Configuración de velas
const CANDLE_INTERVALS = {
  '15s': 15000,    // 15 segundos
  '30s': 30000,    // 30 segundos
  '1m': 60000,     // 1 minuto
  '2m': 120000,    // 2 minutos
  '5m': 300000,    // 5 minutos
};

// Thresholds de momentum
const MOMENTUM_CONFIG = {
  // % mínimo de subida por intervalo
  '15s': parseFloat(process.env.MIN_MOMENTUM_15S || '10'),  // 10% en 15s
  '30s': parseFloat(process.env.MIN_MOMENTUM_30S || '20'),  // 20% en 30s
  '1m': parseFloat(process.env.MIN_MOMENTUM_1M || '30'),    // 30% en 1m
  '2m': parseFloat(process.env.MIN_MOMENTUM_2M || '50'),    // 50% en 2m
  '5m': parseFloat(process.env.MIN_MOMENTUM_5M || '100'),   // 100% en 5m
};

export class CandleAnalyzer {
  constructor() {
    this.priceHistory = new Map(); // mint -> [{price, timestamp}]
    console.log('📊 CandleAnalyzer initialized');
    console.log('   Intervals:', Object.keys(CANDLE_INTERVALS).join(', '));
    console.log('   Momentum thresholds:');
    for (const [interval, minGain] of Object.entries(MOMENTUM_CONFIG)) {
      console.log(`      ${interval}: +${minGain}%`);
    }
  }

  /**
   * Registra un precio en el historial
   */
  async recordPrice(mint, price, timestamp = Date.now()) {
    if (!mint || !price || price <= 0) return;

    const key = `price_history:${mint}`;
    
    // Guardar en memoria
    if (!this.priceHistory.has(mint)) {
      this.priceHistory.set(mint, []);
    }
    
    const history = this.priceHistory.get(mint);
    history.push({ price, timestamp });

    // Guardar en Redis (para persistencia)
    try {
      await redis.zadd(key, timestamp, JSON.stringify({ price, timestamp }));
      
      // Limpiar histórico viejo (más de 10 minutos)
      const tenMinutesAgo = Date.now() - 600000;
      await redis.zremrangebyscore(key, 0, tenMinutesAgo);
      
      // Expirar key en 1 hora
      await redis.expire(key, 3600);
    } catch (error) {
      console.log(`⚠️ Error saving price history: ${error.message}`);
    }

    // Limpiar memoria (mantener últimos 10 minutos)
    const cutoff = Date.now() - 600000;
    const filtered = history.filter(p => p.timestamp >= cutoff);
    this.priceHistory.set(mint, filtered);
  }

  /**
   * Carga historial desde Redis
   */
  async loadHistory(mint) {
    if (!mint) return [];

    try {
      const key = `price_history:${mint}`;
      const data = await redis.zrange(key, 0, -1);
      
      const history = [];
      for (const item of data) {
        try {
          const parsed = JSON.parse(item);
          if (parsed.price && parsed.timestamp) {
            history.push(parsed);
          }
        } catch {}
      }

      this.priceHistory.set(mint, history);
      return history;
    } catch (error) {
      console.log(`⚠️ Error loading history: ${error.message}`);
      return [];
    }
  }

  /**
   * Calcula el % de cambio en un intervalo específico
   */
  calculateGain(mint, intervalMs) {
    const history = this.priceHistory.get(mint) || [];
    
    if (history.length < 2) {
      return null; // No hay suficientes datos
    }

    const now = Date.now();
    const cutoff = now - intervalMs;

    // Encontrar precio más antiguo en el intervalo
    const oldPrices = history.filter(p => p.timestamp >= cutoff);
    
    if (oldPrices.length < 2) {
      return null;
    }

    const oldestPrice = oldPrices[0].price;
    const newestPrice = oldPrices[oldPrices.length - 1].price;

    if (!oldestPrice || oldestPrice <= 0) {
      return null;
    }

    const gainPercent = ((newestPrice - oldestPrice) / oldestPrice) * 100;

    return {
      oldPrice: oldestPrice,
      newPrice: newestPrice,
      gainPercent,
      dataPoints: oldPrices.length,
    };
  }

  /**
   * Analiza todas las velas y detecta momentum
   */
  async analyzeMomentum(mint) {
    const results = {};
    let hasMomentum = false;
    const signals = [];

    for (const [interval, intervalMs] of Object.entries(CANDLE_INTERVALS)) {
      const gain = this.calculateGain(mint, intervalMs);
      
      if (!gain) {
        results[interval] = { 
          gainPercent: 0, 
          hasData: false,
          hasMomentum: false,
        };
        continue;
      }

      const minGain = MOMENTUM_CONFIG[interval] || 0;
      const isStrong = gain.gainPercent >= minGain;

      results[interval] = {
        oldPrice: gain.oldPrice,
        newPrice: gain.newPrice,
        gainPercent: gain.gainPercent,
        dataPoints: gain.dataPoints,
        hasData: true,
        hasMomentum: isStrong,
        threshold: minGain,
      };

      if (isStrong) {
        hasMomentum = true;
        signals.push(`${interval}: +${gain.gainPercent.toFixed(1)}%`);
      }
    }

    return {
      mint,
      results,
      hasMomentum,
      signals,
      timestamp: Date.now(),
    };
  }

  /**
   * Actualiza el precio de un token y analiza
   */
  async updateAndAnalyze(mint) {
    try {
      // Obtener precio actual del RPC (bonding curve)
      const priceData = await priceService.getPrice(mint, true);
      
      if (!priceData || !priceData.price || priceData.price <= 0) {
        return null;
      }

      const currentPrice = priceData.price;

      // Registrar precio
      await this.recordPrice(mint, currentPrice);

      // Analizar momentum
      const analysis = await this.analyzeMomentum(mint);

      return {
        ...analysis,
        currentPrice,
        source: priceData.source,
      };

    } catch (error) {
      console.log(`⚠️ Error in updateAndAnalyze: ${error.message}`);
      return null;
    }
  }

  /**
   * Verifica si un token tiene suficiente momentum para entrar
   */
  async shouldSnipe(mint) {
    const analysis = await this.updateAndAnalyze(mint);
    
    if (!analysis) {
      return {
        snipe: false,
        reason: 'no_price_data',
      };
    }

    if (!analysis.hasMomentum) {
      return {
        snipe: false,
        reason: 'no_momentum',
        analysis,
      };
    }

    // Verificar que haya momentum en al menos 2 intervalos
    const momentumIntervals = Object.values(analysis.results)
      .filter(r => r.hasMomentum);

    if (momentumIntervals.length < 2) {
      return {
        snipe: false,
        reason: 'insufficient_momentum_intervals',
        analysis,
      };
    }

    return {
      snipe: true,
      reason: 'strong_momentum',
      analysis,
      signals: analysis.signals,
    };
  }

  /**
   * Limpia el historial de un token
   */
  async clearHistory(mint) {
    this.priceHistory.delete(mint);
    
    try {
      await redis.del(`price_history:${mint}`);
    } catch {}
  }

  /**
   * Stats del analyzer
   */
  getStats() {
    const totalTracked = this.priceHistory.size;
    let totalDataPoints = 0;

    for (const history of this.priceHistory.values()) {
      totalDataPoints += history.length;
    }

    return {
      tokensTracked: totalTracked,
      totalDataPoints,
      avgDataPointsPerToken: totalTracked > 0 
        ? (totalDataPoints / totalTracked).toFixed(1)
        : '0',
    };
  }
}

// Singleton
let analyzerInstance = null;

export function getCandleAnalyzer() {
  if (!analyzerInstance) {
    analyzerInstance = new CandleAnalyzer();
  }
  return analyzerInstance;
}

console.log('📊 candleAnalyzer.js loaded');
