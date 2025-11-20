// flintrClient.js - Flintr WebSocket listener (Pump.fun only)
// ✅ Guarda metadata de tokens en Redis: flintr:meta:<mint>
// ✅ Se usa SOLO para información, no para precios ni ejecución

import WebSocket from 'ws';
import IORedis from 'ioredis';

const FLINTR_API_KEY = process.env.FLINTR_API_KEY || '';

// 🔧 URL corregida según la documentación oficial:
// Debe ser: wss://api-v1.flintr.io/sub?token=YOUR_API_KEY
const FLINTR_WS_URL = FLINTR_API_KEY
  ? `wss://api-v1.flintr.io/sub?token=${FLINTR_API_KEY}`
  : null;

let ws = null;
let redis = null;
let reconnectTimeout = null;
let started = false;

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

async function storeFlintrSignal(signal) {
  if (!redis) return;

  try {
    const { event = {}, data = {}, timeSent, timeDetected, signature } = signal;
    const metaData = data.metaData || {};
    const tokenData = data.tokenData || {};
    const ammData = data.ammData || {};
    const platformData = data.platformData || {};

    const mint = data.mint;
    if (!mint) return;

    const key = `flintr:meta:${mint}`;

    const fields = {
      mint,
      platform: event.platform || '',
      eventType: event.type || '',
      // General
      timeSent: timeSent ? String(timeSent) : '',
      timeDetected: timeDetected ? String(timeDetected) : '',
      signature: signature || '',
      // MetaData
      name: metaData.name || '',
      symbol: metaData.symbol || '',
      description: metaData.description || '',
      image: metaData.image || '',
      twitter: metaData.twitter || '',
      telegram: metaData.telegram || '',
      website: metaData.website || '',
      createdOn: metaData.createdOn || '',
      // TokenData
      mintDatetime: tokenData.mintDatetime ? String(tokenData.mintDatetime) : '',
      creator: tokenData.creator || '',
      decimals:
        typeof tokenData.decimals === 'number'
          ? String(tokenData.decimals)
          : '',
      updateAuthority: tokenData.updateAuthority || '',
      mintAuthority: tokenData.mintAuthority || '',
      freezeAuthority: tokenData.freezeAuthority || '',
      isBundled:
        typeof tokenData.isBundled === 'boolean'
          ? String(tokenData.isBundled)
          : '',
      bundleAmount:
        tokenData.bundleAmount !== undefined
          ? String(tokenData.bundleAmount)
          : '',
      latestPrice:
        tokenData.latestPrice !== undefined
          ? String(tokenData.latestPrice)
          : '',
      migrateInstruction:
        tokenData.migrateInstruction !== undefined
          ? String(tokenData.migrateInstruction)
          : '',
      lockedLP:
        tokenData.lockedLP !== undefined ? String(tokenData.lockedLP) : '',
      totalSupply:
        tokenData.totalSupply !== undefined
          ? String(tokenData.totalSupply)
          : '',
      quoteAmount:
        tokenData.quoteAmount !== undefined
          ? String(tokenData.quoteAmount)
          : '',
      baseAmount:
        tokenData.baseAmount !== undefined
          ? String(tokenData.baseAmount)
          : '',
      // AMM data
      bondingCurve: ammData.bondingCurve || '',
      associatedBondingCurve: ammData.associatedBondingCurve || '',
      vaultCreatorATA: ammData.vaultCreatorATA || '',
      vaultCreatorAuthority: ammData.vaultCreatorAuthority || '',
      ammId: ammData.ammId || '',
      poolBase: ammData.poolBase || '',
      poolQuote: ammData.poolQuote || '',
      quoteMint: ammData.quoteMint || '',
      ammType: ammData.ammType || '',
      // Platform data (cuando hay graduación)
      marketCapInSOL:
        platformData.marketCapInSOL !== undefined
          ? String(platformData.marketCapInSOL)
          : '',
      pumpTrades:
        platformData.pumpTrades !== undefined
          ? String(platformData.pumpTrades)
          : '',
      pumpLikes:
        platformData.pumpLikes !== undefined
          ? String(platformData.pumpLikes)
          : '',
      pumpReplies:
        platformData.pumpReplies !== undefined
          ? String(platformData.pumpReplies)
          : '',
    };

    await redis.hset(key, fields);
    // Mantener metadata por 6 horas
    await redis.expire(key, 60 * 60 * 6);
  } catch (error) {
    console.log('⚠️ Error storing Flintr signal:', error?.message || String(error));
  }
}

function setupWebsocket() {
  if (!FLINTR_WS_URL) {
    console.log('⚠️ FLINTR_API_KEY not set - Flintr listener disabled');
    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  console.log('🌐 Connecting to Flintr WebSocket...');
  ws = new WebSocket(FLINTR_WS_URL);

  ws.on('open', () => {
    console.log('✅ Flintr WebSocket connected (firehose mode, all platforms)');
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

      // Solo tokens de Pump.fun (mint / graduation)
      if (event.class === 'token' && event.platform === 'pump.fun') {
        await storeFlintrSignal(payload);
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
 * Inicia el listener de Flintr (una sola vez).
 * @param {import('ioredis').Redis} externalRedis
 */
export function startFlintrListener(externalRedis) {
  if (started) {
    return ws;
  }
  started = true;

  try {
    ensureRedis(externalRedis);
  } catch (error) {
    console.log(
      '⚠️ Flintr listener disabled (Redis not available):',
      error?.message || String(error),
    );
    return null;
  }

  if (!FLINTR_WS_URL) {
    console.log('⚠️ FLINTR_API_KEY not set - Flintr listener disabled');
    return null;
  }

  setupWebsocket();
  console.log('🔥 Flintr listener started (Pump.fun token metadata cache)');
  return ws;
}

/**
 * Obtiene la metadata de Flintr para un mint (si existe en Redis).
 * @param {string} mint
 * @param {import('ioredis').Redis} externalRedis
 * @returns {Promise<object|null>}
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
