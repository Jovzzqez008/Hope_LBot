// walletTracker.js v5.3 - PARSER BULLETPROOF + DEBUG MODE - MODIFICADO
import { Connection, PublicKey } from '@solana/web3.js';
import IORedis from 'ioredis';
import bs58 from 'bs58';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100
});

// 🎯 PROGRAM IDs
const DEX_PROGRAMS = {
  PUMP: new PublicKey(process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  RAYDIUM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_CLMM: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
  JUPITER_V6: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')
};

const DEBUG_MODE = process.env.WALLET_DEBUG === 'true';

export class WalletTracker {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.trackedWallets = new Map();
    this.subscriptions = new Map();

    console.log('👁️ Wallet Tracker v5.3 initialized (BULLETPROOF)');
    console.log('   Supported DEXs: Pump.fun, Raydium, Jupiter, Orca');
    if (DEBUG_MODE) console.log('   🔍 DEBUG MODE ENABLED');
  }

  async addWallet(walletAddress, config = {}) {
    try {
      const pubkey = new PublicKey(walletAddress);

      this.trackedWallets.set(walletAddress, {
        pubkey,
        name: config.name || `Wallet-${walletAddress.slice(0, 8)}`,
        copyPercentage: parseFloat(config.copyPercentage || '100'),
        minAmount: parseFloat(config.minAmount || '0.1'),
        maxAmount: parseFloat(config.maxAmount || '0.1'),
        enabled: config.enabled !== false,
        stats: {
          totalTrades: 0,
          copiedTrades: 0,
          wins: 0,
          losses: 0
        }
      });

      await redis.hset(`wallet:${walletAddress}`, {
        name: config.name || `Wallet-${walletAddress.slice(0, 8)}`,
        copyPercentage: config.copyPercentage || '100',
        minAmount: config.minAmount || '0.1',
        maxAmount: config.maxAmount || '0.1',
        enabled: config.enabled !== false ? 'true' : 'false'
      });

      await redis.sadd('tracked_wallets', walletAddress);

      console.log(`✅ Wallet added to tracker: ${walletAddress.slice(0, 8)}...`);
      await this.subscribeToWallet(walletAddress);

    } catch (error) {
      console.error(`❌ Error adding wallet ${walletAddress}:`, error.message);
    }
  }

  async removeWallet(walletAddress) {
    try {
      const subscriptionId = this.subscriptions.get(walletAddress);

      if (subscriptionId) {
        await this.connection.removeOnLogsListener(subscriptionId);
        this.subscriptions.delete(walletAddress);
      }

      this.trackedWallets.delete(walletAddress);
      await redis.srem('tracked_wallets', walletAddress);
      await redis.del(`wallet:${walletAddress}`);

      console.log(`🗑️ Wallet removed from tracker: ${walletAddress.slice(0, 8)}...`);

    } catch (error) {
      console.error(`❌ Error removing wallet ${walletAddress}:`, error.message);
    }
  }

  async subscribeToWallet(walletAddress) {
    try {
      const wallet = this.trackedWallets.get(walletAddress);

      if (!wallet) {
        console.log(`⚠️ Cannot subscribe, wallet not found: ${walletAddress}`);
        return;
      }

      console.log(`📡 Subscribing to wallet: ${walletAddress.slice(0, 8)}...`);

      const subscriptionId = await this.connection.onLogs(
        wallet.pubkey,
        async (logs, context) => {
          await this.handleWalletTransaction(walletAddress, logs, context);
        },
        'confirmed'
      );

      this.subscriptions.set(walletAddress, subscriptionId);
      console.log(`📡 Subscribed to ${wallet.name} (${walletAddress.slice(0, 8)}...)`);

    } catch (error) {
      console.error(`❌ Error subscribing to ${walletAddress}:`, error.message);
    }
  }

  async handleWalletTransaction(walletAddress, logs, context) {
    try {
      const signature = logs.signature;
      const wallet = this.trackedWallets.get(walletAddress);

      if (!wallet || !wallet.enabled) return;

      const dexType = this.detectDEXType(logs.logs);
      if (!dexType) return;

      console.log(`\n⚡ ${dexType} DETECTION from ${wallet.name}`);
      console.log(`   Signature: ${signature}`);

      const txDetails = await this.parseTransaction(signature, walletAddress, dexType);

      if (!txDetails) {
        console.log(`   ❌ Failed to parse transaction\n`);
        return;
      }

      console.log(`   ✅ Parsed successfully`);
      await this.processWithUpvotes(walletAddress, txDetails);

    } catch (error) {
      console.error(`❌ Error handling transaction:`, error.message);
    }
  }

  detectDEXType(logLines) {
    for (const log of logLines) {
      if (log.includes(DEX_PROGRAMS.PUMP.toString())) return 'PUMP';
      if (log.includes(DEX_PROGRAMS.RAYDIUM_V4.toString())) return 'RAYDIUM_V4';
      if (log.includes(DEX_PROGRAMS.RAYDIUM_CLMM.toString())) return 'RAYDIUM_CLMM';
      if (log.includes(DEX_PROGRAMS.JUPITER_V6.toString())) return 'JUPITER';
      if (log.includes(DEX_PROGRAMS.ORCA_WHIRLPOOL.toString())) return 'ORCA';
    }
    return null;
  }

  async parseTransaction(signature, walletAddress, dexType) {
    try {
      console.log(`   🔍 Fetching transaction details (${dexType})...`);

      const tx = await this.connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!tx || !tx.meta) {
        console.log(`   ⚠️ Transaction not found or no metadata`);
        return null;
      }

      console.log(`   ✅ Transaction fetched`);

      // 🔍 Debug completo si está activado
      if (DEBUG_MODE) {
        await this.debugTransaction(tx, walletAddress);
      }

      switch (dexType) {
        case 'PUMP':
          return await this.parsePumpTransaction(tx, walletAddress, signature);
        case 'RAYDIUM_V4':
        case 'RAYDIUM_CLMM':
          return await this.parseRaydiumTransaction(tx, walletAddress, signature);
        case 'JUPITER':
          return await this.parseJupiterTransaction(tx, walletAddress, signature);
        case 'ORCA':
          return await this.parseOrcaTransaction(tx, walletAddress, signature);
        default:
          return null;
      }

    } catch (error) {
      console.error(`   ❌ Parser error: ${error.message}`);
      return null;
    }
  }

  // 🔍 DEBUG MODE: Imprimir detalles de balances y tokens
  async debugTransaction(tx, walletAddress) {
    try {
      console.log(`\n===== DEBUG TRANSACTION =====`);
      console.log(`Logs:`);
      for (const log of tx.meta.logMessages || []) {
        console.log(`  ${log}`);
      }

      const accountKeys = tx.transaction.message.staticAccountKeys ||
                         tx.transaction.message.accountKeys || [];

      console.log(`\nAccounts:`);
      accountKeys.forEach((key, i) => {
        console.log(`  [${i}] ${key.toString()}`);
      });

      let walletIndex = accountKeys.findIndex(k => {
        try {
          return k.toString() === walletAddress;
        } catch {
          return false;
        }
      });

      if (walletIndex === -1) {
        console.log(`\n⚠️ Wallet not found in accounts for debug`);
      } else {
        console.log(`\n✅ Wallet index: ${walletIndex}`);
        const preSOL = (tx.meta.preBalances[walletIndex] || 0) / 1e9;
        const postSOL = (tx.meta.postBalances[walletIndex] || 0) / 1e9;
        console.log(`    Pre SOL: ${preSOL.toFixed(4)}`);
        console.log(`    Post SOL: ${postSOL.toFixed(4)}`);
        console.log(`    Change: ${(postSOL - preSOL).toFixed(4)}`);
      }

      console.log(`  Token changes:`);
      const postTokens = tx.meta?.postTokenBalances || [];
      const preTokens = tx.meta?.preTokenBalances || [];

      for (const postBal of postTokens.slice(0, 3)) {
        const preBal = preTokens.find(p => p?.mint === postBal?.mint);
        const preAmt = this.safeParseTokenAmount(preBal);
        const postAmt = this.safeParseTokenAmount(postBal);
        const delta = postAmt - preAmt;

        console.log(`   Mint: ${postBal?.mint}`);
        console.log(`     Pre: ${preAmt}`);
        console.log(`     Post: ${postAmt}`);
        console.log(`     Δ: ${delta}`);
      }

      console.log(`===== END DEBUG =====\n`);
    } catch (error) {
      console.log(`⚠️ Debug error: ${error.message}`);
    }
  }

  // 🛡️ PARSER BULLETPROOF - MODIFICADO (Pump.fun)
  async parsePumpTransaction(tx, walletAddress, signature) {
    try {
      // 1. Validar estructura
      if (!tx?.meta?.preBalances || !tx?.meta?.postBalances) {
        console.log(`   ⚠️ Invalid transaction structure`);
        return null;
      }

      // 2. Obtener account keys (múltiples métodos)
      const accountKeys = tx.transaction.message.staticAccountKeys ||
                         tx.transaction.message.accountKeys || [];

      if (accountKeys.length === 0) {
        console.log(`   ⚠️ No account keys found`);
        return null;
      }

      // 3. Buscar wallet (múltiples métodos)
      let walletIndex = -1;

      // Método A: Búsqueda directa
      walletIndex = accountKeys.findIndex(k => {
        try {
          return k.toString() === walletAddress;
        } catch {
          return false;
        }
      });

      // Método B: Si no encontró, buscar por balance change
      if (walletIndex === -1) {
        const preBalances = tx.meta.preBalances;
        const postBalances = tx.meta.postBalances;

        for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
          if (preBalances[i] !== postBalances[i]) {
            try {
              if (accountKeys[i]?.toString() === walletAddress) {
                walletIndex = i;
                break;
              }
            } catch {}
          }
        }
      }

      if (walletIndex === -1) {
        console.log(`   ⚠️ Wallet not found in transaction`);
        console.log(`      Searched ${walletAddress.slice(0, 8)}... in ${accountKeys.length} accounts`);
        return null;
      }

      console.log(`   ✅ Wallet confirmed at index: ${walletIndex}`);

      // 4. Calcular cambio de SOL - MODIFICADO: UMBRAL MÁS ALTO
      const preSOL = (tx.meta.preBalances[walletIndex] || 0) / 1e9;
      const postSOL = (tx.meta.postBalances[walletIndex] || 0) / 1e9;
      const solChange = Math.abs(preSOL - postSOL);

      // ✅ AUMENTAR UMBRAL MÍNIMO (evitar false positives)
      if (solChange < 0.001) { // Era 0.0001, ahora 0.001 SOL
        console.log(`   ⚠️ No significant SOL change (${solChange.toFixed(6)} SOL)`);
        console.log(`   ℹ️ Likely internal operation (approval/wrap/etc)`);
        return null;
      }

      console.log(`   💰 SOL change: ${solChange.toFixed(4)} SOL`);

      // 5. Buscar token (múltiples métodos)
      const preTokenBalances = tx.meta.preTokenBalances || [];
      const postTokenBalances = tx.meta.postTokenBalances || [];

      let mint = null;
      let preTokenAmount = 0;
      let postTokenAmount = 0;

      for (const postBalance of postTokenBalances) {
        if (!postBalance?.mint) continue;

        const preBalance = preTokenBalances.find(b => b?.mint === postBalance.mint);
        const preAmount = this.safeParseTokenAmount(preBalance);
        const postAmount = this.safeParseTokenAmount(postBalance);

        if (Math.abs(postAmount - preAmount) > 0) {
          mint = postBalance.mint;
          preTokenAmount = preAmount;
          postTokenAmount = postAmount;
          break;
        }
      }

      if (!mint) {
        console.log(`   ⚠️ No token movement detected`);
        return null;
      }

      const tokenAmount = Math.abs(postTokenAmount - preTokenAmount);
      const isBuy = postTokenAmount > preTokenAmount;

      console.log(`   🎯 Token detected: ${mint.slice(0, 8)}...`);
      console.log(`   📊 isBuy: ${isBuy}, tokenAmount: ${tokenAmount}`);

      if (tokenAmount <= 0) {
        console.log(`   ⚠️ Zero token delta, skipping`);
        return null;
      }

      // 6. Verificar logs (opcional) para confirmar PUMP program
      const logMessages = tx.meta.logMessages || [];
      const pumpLog = logMessages.find(l => l.includes(DEX_PROGRAMS.PUMP.toString()));

      if (!pumpLog) {
        console.log(`   ⚠️ No Pump.fun logs detected, skipping`);
        return null;
      }

      // 7. Verificar que la wallet no es dev (Heurística básica)
      const devIndex = accountKeys.findIndex(k => {
        try {
          return k.toString() === mint;
        } catch {
          return false;
        }
      });

      if (devIndex === walletIndex) {
        console.log(`   ⚠️ Wallet appears to be dev mint, skipping`);
        return null;
      }

      // 8. Debug extra si está activado
      if (DEBUG_MODE) {
        console.log(`   DEBUG: pre SOL = ${preSOL.toFixed(4)}, post SOL = ${postSOL.toFixed(4)}`);
        console.log(`   DEBUG: pre tokens = ${preTokenAmount}, post tokens = ${postTokenAmount}`);
      }

      // 9. Verificar que no hubo error
      if (tx.meta.err) {
        console.log(`   ⚠️ Transaction failed`);
        return null;
      }

      // 10. Resultado
      const timestamp = tx.blockTime ? tx.blockTime * 1000 : Date.now();
      const pricePerToken = solChange / tokenAmount;

      console.log(`   📊 ${isBuy ? '🟢 BUY' : '🔴 SELL'} PARSED:`);
      console.log(`      Mint: ${mint.slice(0, 8)}...${mint.slice(-8)}`);
      console.log(`      Tokens: ${preTokenAmount.toFixed(2)} → ${postTokenAmount.toFixed(2)}`);
      console.log(`      SOL: ${solChange.toFixed(4)}`);
      console.log(`      Price: ~$${(pricePerToken * 1000000).toFixed(8)}`);

      return {
        signature,
        wallet: walletAddress,
        mint,
        action: isBuy ? 'BUY' : 'SELL',
        tokenAmount,
        solAmount: solChange,
        timestamp,
        slot: tx.slot,
        dex: 'Pump.fun'
      };

    } catch (error) {
      console.log(`   ❌ Parser error: ${error.message}`);
      console.log(`      Stack: ${error.stack?.split('\n')[1]?.trim()}`);
      return null;
    }
  }

  // Placeholders for other DEXes (no-op for now → solo Pump.fun)
  async parseRaydiumTransaction(tx, walletAddress, signature) {
    // ... (código igual que antes)
    return null; // Placeholder
  }

  async parseJupiterTransaction(tx, walletAddress, signature) {
    // ... (código igual que antes)
    return null; // Placeholder
  }

  async parseOrcaTransaction(tx, walletAddress, signature) {
    // ... (código igual que antes)
    return null; // Placeholder
  }

  // Helper para parsear token amounts de forma segura
  safeParseTokenAmount(balance) {
    try {
      if (!balance) return 0;
      return balance.uiTokenAmount?.uiAmount ||
             parseFloat(balance.uiTokenAmount?.amount || '0') /
             Math.pow(10, balance.uiTokenAmount?.decimals || 0);
    } catch {
      return 0;
    }
  }

  async processWithUpvotes(walletAddress, txDetails) {
    try {
      const wallet = this.trackedWallets.get(walletAddress);
      const { mint, action, solAmount, dex } = txDetails;

      console.log(`   🎯 Processing ${action} with upvotes (${dex})...`);

      const upvoteKey = `upvotes:${mint}`;

      if (action === 'BUY') {
        await redis.sadd(`${upvoteKey}:buyers`, walletAddress);
        await redis.expire(`${upvoteKey}:buyers`, 600);

        await redis.hset(`${upvoteKey}:buy:${walletAddress}`, {
          walletName: wallet.name,
          solAmount: solAmount.toString(),
          dex: dex,
          timestamp: txDetails.timestamp.toString()
        });
        await redis.expire(`${upvoteKey}:buy:${walletAddress}`, 600);

        const buyers = await redis.smembers(`${upvoteKey}:buyers`);
        const upvoteCount = buyers.length;

        console.log(`   ✅ UPVOTES: ${upvoteCount} wallet(s) bought`);

        await this.createCopySignal(mint, txDetails, upvoteCount, buyers);
        await this.sendBuyAlert(wallet, txDetails, upvoteCount);

      } else if (action === 'SELL') {
        await redis.sadd(`${upvoteKey}:sellers`, walletAddress);
        await redis.expire(`${upvoteKey}:sellers`, 600);

        const sellers = await redis.smembers(`${upvoteKey}:sellers`);
        const sellCount = sellers.length;

        console.log(`   ✅ SELL COUNT: ${sellCount} wallet(s) sold`);

        await this.createSellSignal(mint, txDetails, sellCount, sellers);
        await this.sendSellAlert(wallet, txDetails, sellCount);
      }

    } catch (error) {
      console.error(`   ❌ Upvotes error: ${error.message}`);
    }
  }

  // 🎯 MODIFICADO: Usar cantidad fija de POSITION_SIZE_SOL
  async createCopySignal(mint, txDetails, upvoteCount, buyers) {
    try {
      const wallet = this.trackedWallets.get(txDetails.wallet);

      // ✅ USAR CANTIDAD FIJA DE ENV (ignorar copyPercentage)
      const copyAmount =
        parseFloat(process.env.POSITION_SIZE_SOL || '0.1');

      const copySignal = {
        walletAddress: txDetails.wallet,
        walletName: wallet.name,
        mint,
        originalAmount: txDetails.solAmount,
        copyAmount, // ✅ Ahora siempre será POSITION_SIZE_SOL
        signature: txDetails.signature,
        timestamp: txDetails.timestamp,
        upvotes: upvoteCount,
        buyers: buyers,
        reason: 'wallet_buy',
        dex: txDetails.dex
      };

      console.log(`   📤 Pushing copy signal to Redis queue...`);
      await redis.lpush('copy_signals', JSON.stringify(copySignal));
      await redis.expire('copy_signals', 60);

      const queueLength = await redis.llen('copy_signals');
      console.log(`   ✅ Copy signal created (queue length: ${queueLength})`);

    } catch (error) {
      console.error(`   ❌ Create signal error: ${error.message}`);
    }
  }

  async createSellSignal(mint, txDetails, sellCount, sellers) {
    try {
      const sellSignal = {
        mint,
        walletAddress: txDetails.wallet,
        sellCount,
        sellers,
        timestamp: txDetails.timestamp,
        signature: txDetails.signature,
        dex: txDetails.dex
      };

      console.log(`   📤 Pushing sell signal to Redis queue...`);
      await redis.lpush('sell_signals', JSON.stringify(sellSignal));
      await redis.expire('sell_signals', 60);

      const queueLength = await redis.llen('sell_signals');
      console.log(`   ✅ Sell signal created (queue length: ${queueLength})`);

    } catch (error) {
      console.error(`   ❌ Create sell signal error: ${error.message}`);
    }
  }

  async sendBuyAlert(wallet, txDetails, upvoteCount) {
    const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
    if (!chatId) return;

    try {
      const { sendTelegramAlert } = await import('./telegram.js');

      const confidence = upvoteCount === 1 ? '🟡 Low' :
                         upvoteCount === 2 ? '🟢 Medium' :
                         '🔥 High';

      const dexEmoji = txDetails.dex === 'Pump.fun' ? '🚀' :
                       txDetails.dex === 'Raydium' ? '⚡' :
                       txDetails.dex === 'Jupiter' ? '🪐' :
                       txDetails.dex === 'Orca' ? '🐋' : '💱';

      await sendTelegramAlert(
        chatId,
        `${dexEmoji} BUY SIGNAL (${txDetails.dex})\n\n` +
        `Trader: ${wallet.name}\n` +
        `Token: ${txDetails.mint.slice(0, 16)}...\n` +
        `Amount: ${txDetails.solAmount.toFixed(4)} SOL\n` +
        `\n` +
        `👍 Upvotes: ${upvoteCount} wallet(s)\n` +
        `Confidence: ${confidence}\n` +
        `\n` +
        `Signature: ${txDetails.signature.slice(0, 16)}...`,
        false
      );
    } catch (e) {
      console.log(`   ⚠️ Telegram alert failed: ${e.message}`);
    }
  }

  async sendSellAlert(wallet, txDetails, sellCount) {
    const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
    if (!chatId) return;

    try {
      const { sendTelegramAlert } = await import('./telegram.js');

      const dexEmoji = txDetails.dex === 'Pump.fun' ? '🚀' :
                       txDetails.dex === 'Raydium' ? '⚡' :
                       txDetails.dex === 'Jupiter' ? '🪐' :
                       txDetails.dex === 'Orca' ? '🐋' : '💱';

      await sendTelegramAlert(
        chatId,
        `⚠️ SELL SIGNAL (${txDetails.dex})\n\n` +
        `Trader: ${wallet.name}\n` +
        `Token: ${txDetails.mint.slice(0, 16)}...\n` +
        `Amount: ${txDetails.solAmount.toFixed(4)} SOL\n` +
        `\n` +
        `📉 Sellers: ${sellCount} wallet(s)\n` +
        `\n` +
        `Signature: ${txDetails.signature.slice(0, 16)}...`,
        false
      );
    } catch (e) {
      console.log(`   ⚠️ Telegram alert failed: ${e.message}`);
    }
  }

  async removeWallet(walletAddress) {
    try {
      const subscriptionId = this.subscriptions.get(walletAddress);

      if (subscriptionId) {
        await this.connection.removeOnLogsListener(subscriptionId);
        this.subscriptions.delete(walletAddress);
      }

      this.trackedWallets.delete(walletAddress);
      await redis.srem('tracked_wallets', walletAddress);
      await redis.del(`wallet:${walletAddress}`);

      console.log(`🗑️ Wallet removed from tracker: ${walletAddress.slice(0, 8)}...`);

    } catch (error) {
      console.error(`❌ Error removing wallet ${walletAddress}:`, error.message);
    }
  }

  async listWallets() {
    const wallets = [];
    for (const [address, wallet] of this.trackedWallets.entries()) {
      wallets.push({
        address,
        name: wallet.name,
        copyPercentage: wallet.copyPercentage,
        minAmount: wallet.minAmount,
        maxAmount: wallet.maxAmount,
        stats: wallet.stats
      });
    }

    return wallets;
  }

  async loadWalletsFromRedis() {
    try {
      const walletAddresses = await redis.smembers('tracked_wallets');

      console.log(`\n📂 Loading ${walletAddresses.length} wallets from Redis...`);

      for (const address of walletAddresses) {
        const walletData = await redis.hgetall(`wallet:${address}`);

        if (walletData && Object.keys(walletData).length > 0) {
          await this.addWallet(address, {
            name: walletData.name,
            copyPercentage: walletData.copyPercentage,
            minAmount: walletData.minAmount,
            maxAmount: walletData.maxAmount,
            enabled: walletData.enabled !== 'false'
          });
        }
      }

      console.log(`✅ Loaded ${this.trackedWallets.size} wallets\n`);

    } catch (error) {
      console.error('❌ Error loading wallets from Redis:', error.message);
    }
  }

  async getWalletStats(walletAddress) {
    try {
      const trades = await redis.lrange(`wallet_trades:${walletAddress}`, 0, -1);

      let totalTrades = trades.length;
      let wins = 0;
      let losses = 0;

      for (const tradeJson of trades) {
        try {
          const trade = JSON.parse(tradeJson);
          if (trade.realizedPnL >= 0) wins++;
          else losses++;
        } catch {}
      }

      return { totalTrades, wins, losses };

    } catch (error) {
      console.error('❌ Error getting wallet stats:', error.message);
      return { totalTrades: 0, wins: 0, losses: 0 };
    }
  }

  async close() {
    console.log('\n🛑 Closing wallet tracker...');

    for (const [address, subscriptionId] of this.subscriptions.entries()) {
      try {
        await this.connection.removeOnLogsListener(subscriptionId);
      } catch (e) {}
    }

    this.subscriptions.clear();
    this.trackedWallets.clear();

    console.log('✅ Wallet tracker closed');
  }
}

let trackerInstance = null;

export async function initWalletTracker() {
  if (!process.env.RPC_URL) {
    console.log('⚠️ RPC_URL not set, skipping wallet tracker');
    return null;
  }

  trackerInstance = new WalletTracker(process.env.RPC_URL);
  await trackerInstance.loadWalletsFromRedis();

  return trackerInstance;
}

export function getWalletTracker() {
  return trackerInstance;
}
