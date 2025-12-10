// flintrClient.js - Flintr WebSocket para SNIPER (tokens nuevos en tiempo real)
// ✅ Detecta tokens mint en Pump.fun
// ✅ Filtra por metadata (Twitter, etc)
// ✅ Envía señales a Redis para sniperMonitor

import WebSocket from 'ws';
import IORedis from 'ioredis';

const FLINTR_API_KEY = process.env.FLINTR_API_KEY || '';
const FLINTR_WS_URL = FLINTR_API_KEY
  ? `wss://api-v1.flintr.io/sub?token=${FLINTR_API_KEY}`
  : null;

let ws = null;
let redis = null;
let reconnectTimeout = null;
let started = false;

// Estadísticas
let tokensDetected = 0;
let tokensFiltered = 0;
let tokensSniped = 0;

function ensureRedis(externalClient) {
  if (externalClient) {
    redis = externalClient;
    return redis;
  }
  if (!redis) {
    if (!process.env.REDIS_URL) {
      throw new Error('REDIS_URL not set for Flintr client');
    }
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    redis.on('error', (err) => {
      console.log('⚠️ Flintr Redis error:', err?.message || String(err));
    });
  }
  return redis;
}

/**
 * Procesa un token mint de Pump.fun
 */
async function processTokenMint(signal) {
  if (!redis) return;

  try {
    const { event = {}, data = {}, timeSent, timeDetected, signature } = signal;
    
    // Solo tokens mint de Pump.fun
    if (event.class !== 'token' || event.type !== 'mint') {
      return;
    }

    if (event.platform !== 'pump.fun') {
      return;
    }

    tokensDetected++;

    const metaData = data.metaData || {};
    const tokenData = data.tokenData || {};
    const ammData = data.ammData || {};
    const mint = data.mint;

    if (!mint) return;

    console.log(`\n🔥 NEW TOKEN DETECTED: ${mint.slice(0, 8)}...`);
    console.log(`   Name: ${metaData.name || 'Unknown'}`);
    console.log(`   Symbol: ${metaData.symbol || 'N/A'}`);
    console.log(`   Creator: ${tokenData.creator?.slice(0, 8) || 'N/A'}...`);

    // ✅ FILTRO 1: Twitter obligatorio
    const hasTwitter = !!(metaData.twitter && metaData.twitter.includes('x.com'));
    
    console.log(`   Twitter: ${hasTwitter ? '✅ ' + metaData.twitter : '❌ None'}`);

    if (!hasTwitter) {
      console.log(`   ❌ Filtered: No Twitter\n`);
      tokensFiltered++;
      return;
    }

    // ✅ FILTRO 2: Bundle amount (indica volumen inicial)
    const bundleAmount = parseFloat(tokenData.bundleAmount || '0');
    const minBundle = parseFloat(process.env.MIN_BUNDLE_AMOUNT || '0.5');

    console.log(`   Bundle: ${bundleAmount.toFixed(4)} SOL (min: ${minBundle})`);

    if (bundleAmount < minBundle) {
      console.log(`   ❌ Filtered: Bundle too low\n`);
      tokensFiltered++;
      return;
    }

    // ✅ FILTRO 3: No tokens muy viejos (más de 30 segundos)
    const tokenAge = Date.now() - (timeDetected || Date.now());
    const maxAge = parseInt(process.env.MAX_TOKEN_AGE_MS || '30000', 10);

    console.log(`   Age: ${(tokenAge / 1000).toFixed(1)}s (max: ${maxAge / 1000}s)`);

    if (tokenAge > maxAge) {
      console.log(`   ❌ Filtered: Too old\n`);
      tokensFiltered++;
      return;
    }

    // ✅ Guardar metadata en Redis
    const metaKey = `flintr:meta:${mint}`;
    await redis.hset(metaKey, {
      mint,
      name: metaData.name || '',
      symbol: metaData.symbol || '',
      description: metaData.description || '',
      image: metaData.image || '',
      twitter: metaData.twitter || '',
      telegram: metaData.telegram || '',
      website: metaData.website || '',
      creator: tokenData.creator || '',
      decimals: String(tokenData.decimals || 6),
      mintDatetime: String(tokenData.mintDatetime || Date.now()),
      bundleAmount: String(bundleAmount),
      bondingCurve: ammData.bondingCurve || '',
      associatedBondingCurve: ammData.associatedBondingCurve || '',
      detectedAt: String(Date.now()),
    });
    await redis.expire(metaKey, 3600); // 1 hora

    // ✅ Crear señal de sniper
    const sniperSignal = {
      mint,
      name: metaData.name || 'Unknown',
      symbol: metaData.symbol || 'N/A',
      twitter: metaData.twitter || '',
      telegram: metaData.telegram || '',
      website: metaData.website || '',
      image: metaData.image || '',
      description: metaData.description || '',
      creator: tokenData.creator || '',
      bundleAmount,
      bondingCurve: ammData.bondingCurve || '',
      associatedBondingCurve: ammData.associatedBondingCurve || '',
      timestamp: Date.now(),
      signature,
      source: 'flintr_mint',
    };

    console.log(`   ✅ PASSED FILTERS - Creating sniper signal...`);

    await redis.lpush('sniper_signals', JSON.stringify(sniperSignal));
    await redis.ltrim('sniper_signals', 0, 99); // Max 100 señales

    tokensSniped++;

    console.log(`   📊 Stats: Detected=${tokensDetected} | Filtered=${tokensFiltered} | Sniped=${tokensSniped}\n`);

  } catch (error) {
    console.log('⚠️ Error processing token mint:', error?.message || String(error));
  }
}

function setupWebsocket() {
  if (!FLINTR_WS_URL) {
    console.log('⚠️ FLINTR_API_KEY not set - Flintr sniper disabled');
    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  console.log('🌐 Connecting to Flintr WebSocket (sniper mode)...');
  ws = new WebSocket(FLINTR_WS_URL);

  ws.on('open', () => {
    console.log('✅ Flintr WebSocket connected');
    console.log('   Listening for: Pump.fun token mints');
    console.log('   Filters: Twitter required, min bundle, max age\n');
  });

  ws.on('message', async (raw) => {
    try {
      const text = raw.toString();
      if (!text || text === 'ping') return;

      const payload = JSON.parse(text);
      const { event = {} } = payload;

      if (event.class === 'ping') {
        return;
      }

      // Solo tokens mint de Pump.fun
      if (event.class === 'token' && 
          event.type === 'mint' && 
          event.platform === 'pump.fun') {
        await processTokenMint(payload);
      }

    } catch (error) {
      console.log('⚠️ Flintr message error:', error?.message || String(error));
    }
  });

  ws.on('error', (err) => {
    console.log('⚠️ Flintr WebSocket error:', err?.message || String(err));
  });

  ws.on('close', () => {
    console.log('⚠️ Flintr WebSocket closed. Reconnecting in 5s...');
    ws = null;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
      setupWebsocket();
    }, 5000);
  });
}

/**
 * Inicia el listener de Flintr en modo SNIPER
 */
export function startFlintrSniper(externalRedis) {
  if (started) {
    return ws;
  }
  started = true;

  try {
    ensureRedis(externalRedis);
  } catch (error) {
    console.log(
      '⚠️ Flintr sniper disabled (Redis not available):',
      error?.message || String(error),
    );
    return null;
  }

  if (!FLINTR_WS_URL) {
    console.log('⚠️ FLINTR_API_KEY not set - Flintr sniper disabled');
    return null;
  }

  setupWebsocket();
  console.log('🎯 Flintr SNIPER started (Pump.fun new tokens)\n');
  return ws;
}

/**
 * Obtiene la metadata de un token (si existe en Redis)
 */
export async function getFlintrMetadata(mint, externalRedis) {
  if (!mint) return null;
  try {
    const client = ensureRedis(externalRedis);
    const data = await client.hgetall(`flintr:meta:${mint}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return data;
  } catch (error) {
    console.log('⚠️ getFlintrMetadata error:', error?.message || String(error));
    return null;
  }
}

/**
 * Stats del sniper
 */
export function getSniperStats() {
  return {
    tokensDetected,
    tokensFiltered,
    tokensSniped,
    filterRate: tokensDetected > 0 
      ? ((tokensFiltered / tokensDetected) * 100).toFixed(1) + '%'
      : '0%',
    snipeRate: tokensDetected > 0
      ? ((tokensSniped / tokensDetected) * 100).toFixed(1) + '%'
      : '0%',
  };
}

console.log('🎯 flintrClient.js loaded (SNIPER mode)');
