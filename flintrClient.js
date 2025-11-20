// flintrClient.js - Flintr HTTP metadata client (Pump.fun only)
// ✅ Guarda metadata de tokens en Redis: flintr:meta:<mint>
// ✅ Se usa SOLO para información, no para precios ni ejecución
// ✅ SIN WebSocket (modo HTTP-only, estable para Railway)

import IORedis from 'ioredis';

const FLINTR_API_KEY = process.env.FLINTR_API_KEY || '';
const FLINTR_HTTP_BASE = 'https://api-v1.flintr.io';

let redis = null;

/**
 * Asegura un cliente de Redis (interno o externo)
 * @param {import('ioredis').Redis} externalClient
 * @returns {import('ioredis').Redis}
 */
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
 * Normaliza un payload de Flintr (WS o HTTP) a un hash plano para Redis.
 * @param {any} payload
 * @returns {object|null}
 */
function buildFieldsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Intentar leer como en el listener original
  const event = payload.event || {};
  const data = payload.data || payload || {}; // fallback: algunos endpoints pueden poner todo en "data" o raíz
  const metaData = data.metaData || payload.metaData || {};
  const tokenData = data.tokenData || payload.tokenData || {};
  const ammData = data.ammData || payload.ammData || {};
  const platformData = data.platformData || payload.platformData || {};

  const mint = data.mint || payload.mint;
  if (!mint) return null;

  const timeSent = payload.timeSent || payload.createdAt || null;
  const timeDetected = payload.timeDetected || null;
  const signature = payload.signature || '';

  const fields = {
    mint,
    platform: event.platform || data.platform || '',
    eventType: event.type || data.type || '',
    // General
    timeSent: timeSent ? String(timeSent) : '',
    timeDetected: timeDetected ? String(timeDetected) : '',
    signature: signature || '',
    // MetaData
    name: metaData.name || data.name || '',
    symbol: metaData.symbol || data.symbol || '',
    description: metaData.description || data.description || '',
    image: metaData.image || data.image || '',
    twitter: metaData.twitter || data.twitter || '',
    telegram: metaData.telegram || data.telegram || '',
    website: metaData.website || data.website || '',
    createdOn: metaData.createdOn || '',
    // TokenData
    mintDatetime: tokenData.mintDatetime
      ? String(tokenData.mintDatetime)
      : '',
    creator: tokenData.creator || data.creator || '',
    decimals:
      typeof tokenData.decimals === 'number'
        ? String(tokenData.decimals)
        : data.decimals !== undefined
        ? String(data.decimals)
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

  return fields;
}

/**
 * Guarda metadata de Flintr en Redis.
 * @param {any} payload
 * @param {import('ioredis').Redis} client
 * @returns {Promise<object|null>}
 */
async function storeFlintrMetadata(payload, client) {
  if (!client) return null;

  try {
    const fields = buildFieldsFromPayload(payload);
    if (!fields || !fields.mint) return null;

    const key = `flintr:meta:${fields.mint}`;
    await client.hset(key, fields);
    // Mantener metadata por 6 horas
    await client.expire(key, 60 * 60 * 6);

    return fields;
  } catch (error) {
    console.log(
      '⚠️ Error storing Flintr metadata:',
      error?.message || String(error),
    );
    return null;
  }
}

/**
 * Llama a la API HTTP de Flintr para obtener metadata de un mint.
 * @param {string} mint
 * @param {import('ioredis').Redis} externalRedis
 * @returns {Promise<object|null>}
 */
async function fetchFlintrMetadataHTTP(mint, externalRedis) {
  if (!mint) return null;
  if (!FLINTR_API_KEY) {
    console.log(
      '⚠️ FLINTR_API_KEY not set - cannot fetch Flintr metadata via HTTP',
    );
    return null;
  }

  const client = ensureRedis(externalRedis);

  try {
    const url = `${FLINTR_HTTP_BASE}/token/${mint}?token=${FLINTR_API_KEY}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.log(
        `⚠️ Flintr HTTP error for ${mint}: ${res.status} ${res.statusText}`,
      );
      return null;
    }

    const json = await res.json();
    // Intentamos guardar en el mismo formato que antes
    const stored = await storeFlintrMetadata(json, client);
    return stored;
  } catch (error) {
    console.log(
      '⚠️ fetchFlintrMetadataHTTP error:',
      error?.message || String(error),
    );
    return null;
  }
}

/**
 * Obtiene la metadata de Flintr para un mint.
 * 1) Intenta leer desde Redis
 * 2) Si no existe y hay API key, intenta fetch HTTP y cachear
 * @param {string} mint
 * @param {import('ioredis').Redis} externalRedis
 * @returns {Promise<object|null>}
 */
export async function getFlintrMetadata(mint, externalRedis) {
  if (!mint) return null;

  try {
    const client = ensureRedis(externalRedis);
    const key = `flintr:meta:${mint}`;

    // 1) Intentar desde cache
    const cached = await client.hgetall(key);
    if (cached && Object.keys(cached).length > 0) {
      return cached;
    }

    // 2) Si no hay cache, intentar HTTP
    if (!FLINTR_API_KEY) {
      return null;
    }

    const fresh = await fetchFlintrMetadataHTTP(mint, client);
    return fresh;
  } catch (error) {
    console.log(
      '⚠️ getFlintrMetadata error:',
      error?.message || String(error),
    );
    return null;
  }
}
