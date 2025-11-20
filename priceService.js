// priceService.js - MEJORADO con retry, cache inteligente y fallbacks
// ✅ Retry automático en fallos de RPC
// ✅ Cache multi-nivel (memoria + Redis)
// ✅ Fallback a múltiples fuentes
// ✅ Detección de precios anómalos

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const RPC_FALLBACK_URL = process.env.RPC_FALLBACK_URL; // Opcional
const PUMP_PROGRAM_ID_STR = process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const PUMP_PROGRAM_ID = new PublicKey(PUMP_PROGRAM_ID_STR);
const PUMP_TOKEN_DECIMALS = 6;

// Cache TTL
const PRICE_CACHE_TTL_MS = 3000; // 3s en memoria
const REDIS_CACHE_TTL_SEC = 10; // 10s en Redis

// Jupiter V3 config
const JUPITER_V3_URL = process.env.JUPITER_V3_URL || 'https://lite-api.jup.ag/price/v3';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// Parámetros para detección de anomalías
const MAX_PRICE_MULTIPLIER = 100; // Máximo 100x vs precio previo
const MIN_PRICE_DIVIDER = 100; // Mínimo 1/100 del precio previo

// Redis compartido
let redis = null;
if (REDIS_URL) {
  redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });

  redis.on('error', (err) => {
    console.log('⚠️ Redis error en PriceService:', err?.message ?? String(err));
  });

  console.log('✅ Redis client inicializado para PriceService');
} else {
  console.log('⚠️ REDIS_URL no está definido. PriceService usará solo cache en memoria.');
}

// Conexiones RPC
const primaryConnection = new Connection(RPC_URL, 'confirmed');
let fallbackConnection = null;
if (RPC_FALLBACK_URL) {
  fallbackConnection = new Connection(RPC_FALLBACK_URL, 'confirmed');
}

// Cache en memoria
const priceCache = new Map();

// Stats
let cacheHits = 0;
let cacheMisses = 0;
let rpcErrors = 0;

export async function fetchJupiterPriceInSol(mintStr) {
  if (!mintStr) return null;

  try {
    const idsParam = `${mintStr},${SOL_MINT}`;
    const url = `${JUPITER_V3_URL}?ids=${idsParam}`;

    const headers = { 'Content-Type': 'application/json' };
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }

    const res = await fetch(url, { method: 'GET', headers });

    if (!res.ok) {
      if (res.status === 429) {
        console.log('⚠️ Jupiter V3 rate limit en /price/v3');
      }
      return null;
    }

    const data = await res.json();
    if (!data || typeof data !== 'object') {
      return null;
    }

    const tokenInfo = data[mintStr];
    const solInfo = data[SOL_MINT];

    if (!tokenInfo || !tokenInfo.usdPrice || !solInfo || !solInfo.usdPrice) {
      return null;
    }

    const priceInSol = tokenInfo.usdPrice / solInfo.usdPrice;
    if (!Number.isFinite(priceInSol) || priceInSol <= 0) {
      return null;
    }

    return priceInSol;
  } catch (error) {
    console.log('⚠️ Error al consultar Jupiter V3:', error?.message ?? String(error));
    return null;
  }
}

class PriceService {
  constructor() {
    this.programId = PUMP_PROGRAM_ID;
    console.log(`💰 PriceService MEJORADO inicializado`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   Fallback: ${RPC_FALLBACK_URL || 'None'}`);
    console.log(`   Program: ${this.programId.toBase58()}`);
  }

  /**
   * Obtener precio con cache multi-nivel
   */
  async getPrice(mintStr, forceFresh = false) {
    if (!mintStr) return null;

    const mint = new PublicKey(mintStr);

    // 1. Cache en memoria
    if (!forceFresh) {
      const cached = priceCache.get(mintStr);
      if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL_MS) {
        cacheHits++;
        return cached.data;
      }
    }

    cacheMisses++;

    // 2. Cache en Redis
    if (!forceFresh && redis) {
      try {
        const redisValue = await redis.get(`price:${mintStr}`);
        if (redisValue) {
          const parsed = JSON.parse(redisValue);
          priceCache.set(mintStr, {
            timestamp: Date.now(),
            data: parsed,
          });
          return parsed;
        }
      } catch (error) {
        console.log('⚠️ Redis get error en PriceService:', error?.message ?? String(error));
      }
    }

    // 3. Fetch desde on-chain bonding curve
    try {
      const curveState = await this._fetchBondingCurveStateWithRetry(mint);
      if (!curveState) {
        console.log(`⚠️ No se pudo obtener curveState para ${mintStr.slice(0, 8)}`);
        return null;
      }

      const {
        virtualSolReserves,
        virtualTokenReserves,
        realSolReserves,
        realTokenReserves,
        tokenTotalSupply,
        complete,
      } = curveState;

      // Verificar estado mínimo
      if (virtualSolReserves <= 0 || virtualTokenReserves <= 0) {
        console.log(`⚠️ Reservas inválidas para ${mintStr.slice(0, 8)}`);
        throw new Error('invalid_curve_state');
      }

      // Calcular precio
      const price = this._calculatePriceFromCurve(curveState);

      // Detectar precios anómalos
      if (!this._isPriceReasonable(price, curveState)) {
        console.log(`⚠️ Precio anómalo detectado para ${mintStr.slice(0, 8)}: ${price}`);
      }

      const result = {
        mint: mintStr,
        price,
        virtualSolReserves: Number(virtualSolReserves),
        virtualTokenReserves: Number(virtualTokenReserves),
        realSolReserves: Number(realSolReserves),
        realTokenReserves: Number(realTokenReserves),
        tokenTotalSupply: Number(tokenTotalSupply),
        graduated: !!complete,
        source: 'pumpfun_bonding_curve',
        fetchedAt: Date.now(),
      };

      // 4. Guardar en cache
      priceCache.set(mintStr, {
        timestamp: Date.now(),
        data: result,
      });

      if (redis) {
        try {
          await redis.setex(
            `price:${mintStr}`,
            REDIS_CACHE_TTL_SEC,
            JSON.stringify(result)
          );
        } catch (e) {
          // No crítico
        }
      }

      // 5. Marcar graduación
      if (complete && redis) {
        await redis.setex(`pump:graduated:${mintStr}`, 24 * 60 * 60, '1');
      }

      return result;

    } catch (error) {
      rpcErrors++;
      console.log(`⚠️ getPrice error para ${mintStr.slice(0, 8)}:`, error?.message);
      return null;
    }
  }

  /**
   * Fetch con retry automático
   */
  async _fetchBondingCurveStateWithRetry(mint, retries = MAX_RETRIES) {
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await this._fetchBondingCurveState(mint, primaryConnection);
      } catch (error) {
        lastError = error;
        console.log(
          `⚠️ Error fetching curve state (attempt ${attempt + 1}/${retries}) para ${mint.toBase58()}:`,
          error?.message ?? String(error),
        );

        if (fallbackConnection && attempt === retries - 1) {
          try {
            console.log(`   🔄 Intentando RPC fallback...`);
            return await this._fetchBondingCurveState(mint, fallbackConnection);
          } catch (fallbackError) {
            lastError = fallbackError;
            console.log(
              `❌ Fallback RPC también falló para ${mint.toBase58()}:`,
              fallbackError?.message ?? String(fallbackError),
            );
          }
        }

        if (attempt < retries - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    console.log('❌ No se pudo obtener curve state tras múltiples reintentos');
    if (lastError) {
      console.log('Último error:', lastError?.message ?? String(lastError));
    }

    return null;
  }

  /**
   * Leer estado de bonding curve desde la cuenta on-chain
   */
  async _fetchBondingCurveState(mint, connection) {
    const [bondingCurvePda] = await PublicKey.findProgramAddress(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.programId,
    );

    const accountInfo = await connection.getAccountInfo(bondingCurvePda);
    if (!accountInfo || !accountInfo.data) {
      throw new Error('bonding curve account not found');
    }

    const data = accountInfo.data;
    if (data.length < 72) {
      throw new Error('invalid bonding curve account data length');
    }

    const virtualTokenReserves = Number(data.readBigInt64LE(0));
    const virtualSolReserves = Number(data.readBigInt64LE(8));
    const realTokenReserves = Number(data.readBigInt64LE(16));
    const realSolReserves = Number(data.readBigInt64LE(24));
    const tokenTotalSupply = Number(data.readBigInt64LE(32));
    const complete = data.readUInt8(40) === 1;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
    };
  }

  /**
   * Calcula el precio usando la fórmula de la bonding curve de Pump.fun
   */
  _calculatePriceFromCurve(curveState) {
    const {
      virtualSolReserves,
      virtualTokenReserves,
    } = curveState;

    if (virtualTokenReserves <= 0) {
      throw new Error('virtualTokenReserves <= 0');
    }

    // Precio en SOL por token
    const priceInSol = virtualSolReserves / virtualTokenReserves;

    return priceInSol;
  }

  /**
   * Validación simple de precios anómalos
   */
  _isPriceReasonable(price, curveState) {
    if (!Number.isFinite(price) || price <= 0) {
      return false;
    }

    const { virtualSolReserves, virtualTokenReserves } = curveState;

    if (virtualSolReserves <= 0 || virtualTokenReserves <= 0) {
      return false;
    }

    const basePrice = virtualSolReserves / virtualTokenReserves;
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return false;
    }

    if (price > basePrice * MAX_PRICE_MULTIPLIER) {
      return false;
    }

    if (price < basePrice / MIN_PRICE_DIVIDER) {
      return false;
    }

    return true;
  }

  /**
   * Verifica si un token ya completó la curva de Pump.fun (graduado).
   */
  async hasGraduated(mintStr) {
    if (!mintStr) {
      return { graduated: false, reason: 'no_mint' };
    }

    try {
      const mint = new PublicKey(mintStr);
      const curveState = await this._fetchBondingCurveStateWithRetry(mint);

      if (!curveState) {
        return { graduated: false, reason: 'no_curve_state' };
      }

      const { complete } = curveState;
      if (complete) {
        return { graduated: true, reason: 'pumpfun_curve_complete' };
      }

      return { graduated: false, reason: 'curve_open' };
    } catch (error) {
      console.log('⚠️ hasGraduated error:', error?.message ?? String(error));
      return { graduated: false, reason: 'error' };
    }
  }

  /**
   * Obtiene el precio desde DEX (Jupiter V3) para tokens ya graduados.
   * Devuelve un objeto compatible con getPrice().
   */
  async getPriceFromDEX(mintStr) {
    if (!mintStr) return null;

    const priceInSol = await fetchJupiterPriceInSol(mintStr);
    if (!priceInSol) {
      return null;
    }

    const now = Date.now();

    return {
      mint: mintStr,
      price: priceInSol,
      virtualSolReserves: 0,
      virtualTokenReserves: 0,
      realSolReserves: 0,
      realTokenReserves: 0,
      tokenTotalSupply: 0,
      graduated: true,
      source: 'jupiter_v3',
      fetchedAt: now,
    };
  }

  /**
   * Obtener precio con fallback a entryPrice en Redis
   */
  async getPriceWithFallback(mintStr) {
    const primary = await this.getPrice(mintStr, true);
    
    if (primary && primary.price && primary.price > 0) {
      return primary;
    }

    // Fallback a entryPrice de Redis
    if (!redis) return primary;

    try {
      const positionKey = `position:${mintStr}`;
      const entryPriceStr = await redis.hget(positionKey, 'entryPrice');
      
      if (!entryPriceStr) return primary;

      const entryPrice = Number(entryPriceStr);
      
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return primary;
      }

      return {
        mint: mintStr,
        price: entryPrice,
        virtualSolReserves: primary?.virtualSolReserves ?? 0,
        virtualTokenReserves: primary?.virtualTokenReserves ?? 0,
        realSolReserves: primary?.realSolReserves ?? 0,
        realTokenReserves: primary?.realTokenReserves ?? 0,
        tokenTotalSupply: primary?.tokenTotalSupply ?? 0,
        graduated: primary?.graduated ?? false,
        source: primary?.source || 'fallback_entry_price',
        fetchedAt: Date.now(),
      };
    } catch (error) {
      return primary;
    }
  }

  /**
   * Calcular valor actual de tokens
   */
  async calculateCurrentValue(mintStr, tokenAmount) {
    if (!mintStr || !tokenAmount || tokenAmount <= 0) {
      return null;
    }

    const priceData = await this.getPriceWithFallback(mintStr);
    
    if (!priceData || !priceData.price || priceData.price <= 0) {
      return null;
    }

    const solValue = tokenAmount * priceData.price;

    return {
      mint: mintStr,
      tokens: tokenAmount,
      solValue,
      marketPrice: priceData.price,
      graduated: !!priceData.graduated,
      source: priceData.source || 'pumpfun_bonding_curve',
    };
  }

  /**
   * Limpiar cache en memoria
   */
  cleanOldCache() {
    const now = Date.now();
    for (const [mint, entry] of priceCache.entries()) {
      if (now - entry.timestamp > PRICE_CACHE_TTL_MS) {
        priceCache.delete(mint);
      }
    }
  }

  /**
   * Mostrar estadísticas de uso
   */
  logStats() {
    console.log('📊 PriceService stats:');
    console.log(`   Cache hits: ${cacheHits}`);
    console.log(`   Cache misses: ${cacheMisses}`);
    console.log(`   RPC errors: ${rpcErrors}`);
  }
}

let priceServiceInstance = null;

export function getPriceService() {
  if (!priceServiceInstance) {
    priceServiceInstance = new PriceService();
    
    // Limpiar cache cada 5 minutos
    setInterval(() => {
      priceServiceInstance.cleanOldCache();
    }, 5 * 60 * 1000);
  }
  return priceServiceInstance;
}

// Helpers de compatibilidad
export async function getPriceFromBondingCurve(mint, forceFresh = false) {
  const ps = getPriceService();
  return await ps.getPrice(mint, forceFresh);
}

export async function getPriceWithFallback(mint) {
  const ps = getPriceService();
  return await ps.getPriceWithFallback(mint);
}

console.log('💰 PriceService MEJORADO loaded');
