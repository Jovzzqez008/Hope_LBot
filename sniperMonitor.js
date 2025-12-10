// sniperMonitor.js - Monitor principal del bot SNIPER
// ✅ Procesa señales de Flintr en tiempo real
// ✅ Ejecuta entradas con análisis de momentum
// ✅ Monitorea posiciones con precios reales del RPC
// ✅ Salidas automáticas (SL/TP/Trailing)

import IORedis from 'ioredis';
import { Connection } from '@solana/web3.js';
import { getSniperStrategy } from './sniperStrategy.js';
import { getCandleAnalyzer } from './candleAnalyzer.js';
import { getPriceService } from './priceService.js';
import { sendTelegramAlert } from './telegram.js';
import { getFlintrMetadata } from './flintrClient.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
});

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const sniperStrategy = getSniperStrategy();
const candleAnalyzer = getCandleAnalyzer();
const priceService = getPriceService();

const ENABLE_TRADING = process.env.ENABLE_AUTO_TRADING === 'true';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIVE_UPDATES = process.env.TELEGRAM_LIVE_UPDATES !== 'false';

let tradeExecutor, positionManager;

if (ENABLE_TRADING) {
  try {
    const { PositionManager } = await import('./riskManager.js');
    const { TradeExecutor } = await import('./tradeExecutor.js');

    tradeExecutor = new TradeExecutor(
      process.env.PRIVATE_KEY,
      process.env.RPC_URL,
      DRY_RUN,
    );

    positionManager = new PositionManager(redis);

    console.log(`🎯 Sniper Trading ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'} enabled`);
    console.log(`   Executor: TradeExecutor via PumpPortal (Pump.fun)\n`);
  } catch (error) {
    console.error('⚠️ Trading init failed:', error.message);
    tradeExecutor = null;
    positionManager = null;
  }
}

/**
 * Procesa señales de sniper (tokens nuevos de Flintr)
 */
async function processSniperSignals() {
  console.log('🎯 Sniper signals processor started\n');

  while (true) {
    try {
      const signalJson = await Promise.race([
        redis.lpop('sniper_signals'),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const signal = JSON.parse(signalJson);

      console.log(`\n🔥 Processing sniper signal: ${signal.mint.slice(0, 8)}...`);
      console.log(`   Name: ${signal.name || 'Unknown'}`);
      console.log(`   Symbol: ${signal.symbol || 'N/A'}`);
      console.log(`   Bundle: ${signal.bundleAmount || 0} SOL`);
      console.log(`   Twitter: ${signal.twitter || 'None'}`);

      // Iniciar tracking de precios para análisis de velas
      const initialPrice = await priceService.getPrice(signal.mint, true);
      if (initialPrice?.price) {
        await candleAnalyzer.recordPrice(signal.mint, initialPrice.price);
        console.log(`   📊 Initial price: ${initialPrice.price.toFixed(12)} SOL`);
      }

      // Esperar delay para análisis de momentum
      const candleDelay = sniperStrategy.candleAnalysisDelay || 30000;
      console.log(`   ⏳ Waiting ${candleDelay / 1000}s for momentum analysis...`);

      await new Promise((resolve) => setTimeout(resolve, candleDelay));

      // Actualizar precios durante el delay
      for (let i = 0; i < 3; i++) {
        const priceUpdate = await priceService.getPrice(signal.mint, true);
        if (priceUpdate?.price) {
          await candleAnalyzer.recordPrice(signal.mint, priceUpdate.price);
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      // Decidir si snipear
      const decision = await sniperStrategy.shouldSnipe(signal);

      if (!decision.snipe) {
        console.log(`   ❌ Snipe rejected: ${decision.reason}\n`);
        await candleAnalyzer.clearHistory(signal.mint);
        continue;
      }

      console.log(`   ✅ SNIPE APPROVED: ${decision.reason}`);
      if (decision.analysis) {
        console.log(`   📊 Momentum: ${decision.analysis.signals?.join(', ')}`);
      }

      // Obtener precio actual para entrada
      const priceData = await priceService.getPrice(signal.mint, true);

      if (!priceData || !priceData.price || priceData.price <= 0) {
        console.log(`   ❌ Could not get entry price\n`);
        continue;
      }

      const entryPrice = priceData.price;

      console.log(`   💰 Executing SNIPER entry...`);
      console.log(`   💵 Price: ${entryPrice.toFixed(12)} SOL`);
      console.log(`   📊 Amount: ${decision.amount.toFixed(4)} SOL`);

      if (ENABLE_TRADING && tradeExecutor) {
        const buyResult = await tradeExecutor.buyToken(
          signal.mint,
          decision.amount,
        );

        if (buyResult.success) {
          const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';

          console.log(`${mode} SNIPER BUY EXECUTED`);
          console.log(`   Tokens: ${buyResult.tokensReceived}`);
          console.log(`   Signature: ${buyResult.signature}\n`);

          await positionManager.openPosition({
            mint: signal.mint,
            symbol: signal.symbol || '',
            entryPrice,
            solAmount: decision.amount,
            tokensAmount: buyResult.tokensReceived,
            wallet: '',
            entryStrategy: 'sniper',
            source: 'flintr_momentum',
            txId: buyResult.signature,
            extra: {
              name: signal.name || '',
              twitter: signal.twitter || '',
              telegram: signal.telegram || '',
              website: signal.website || '',
              image: signal.image || '',
              description: signal.description || '',
              creator: signal.creator || '',
              bundleAmount: String(signal.bundleAmount || 0),
              bondingCurve: signal.bondingCurve || '',
              confidence: String(decision.confidence || 85),
            },
          });

          await redis.setex(`sniper_cooldown:${signal.mint}`, 300, '1'); // 5 min cooldown

          if (process.env.TELEGRAM_OWNER_CHAT_ID) {
            try {
              await sendTelegramAlert(
                process.env.TELEGRAM_OWNER_CHAT_ID,
                `🎯 SNIPER BUY\n\n` +
                  `${signal.name || 'Unknown'} (${signal.symbol || 'N/A'})\n` +
                  `Mint: ${signal.mint.slice(0, 16)}...\n` +
                  `\n` +
                  `💰 Entry: ${entryPrice.toFixed(12)} SOL\n` +
                  `📊 Size: ${decision.amount.toFixed(4)} SOL\n` +
                  `🔥 Tokens: ${buyResult.tokensReceived.toLocaleString()}\n` +
                  `\n` +
                  `📈 Momentum: ${decision.analysis?.signals?.join(', ') || 'N/A'}\n` +
                  `🐦 Twitter: ${signal.twitter ? 'Yes' : 'No'}\n` +
                  `💼 Bundle: ${signal.bundleAmount || 0} SOL\n` +
                  `\n` +
                  `🎯 Exit Strategy:\n` +
                  `• Take Profit: +${sniperStrategy.takeProfitPercent}%\n` +
                  `• Trailing Stop: -${sniperStrategy.trailingStopPercent}%\n` +
                  `• Stop Loss: -${sniperStrategy.stopLossPercent}%`,
                false,
              );
            } catch (e) {
              console.log('⚠️ Telegram notification failed');
            }
          }
        } else {
          console.log(`❌ BUY FAILED: ${buyResult.error}\n`);
        }
      }
    } catch (error) {
      console.error('❌ Error processing sniper signal:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Monitorea posiciones abiertas en tiempo real
 */
async function monitorOpenPositions() {
  let lastUpdate = {};

  console.log('👁️ Position monitor started\n');

  while (true) {
    try {
      if (!ENABLE_TRADING || !tradeExecutor || !positionManager) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const openPositions = await positionManager.getOpenPositions();
      const sniperPositions = openPositions.filter(
        (p) => p.entry_strategy === 'sniper' || p.strategy === 'sniper',
      );

      for (const position of sniperPositions) {
        try {
          const mint = position.mint;

          // Obtener precio actual del RPC (bonding curve real)
          const priceData = await priceService.getPrice(mint, true);

          if (!priceData || !priceData.price || priceData.price <= 0) {
            console.log(`   ⚠️ No price for ${mint.slice(0, 8)}`);
            continue;
          }

          const currentPrice = priceData.price;

          // Registrar precio para análisis de velas
          await candleAnalyzer.recordPrice(mint, currentPrice);

          const entryPrice = parseFloat(position.entryPrice);
          const solSpent = parseFloat(position.solAmount);
          const tokensAmount = parseInt(position.tokensAmount);

          const currentSolValue = tokensAmount * currentPrice;
          const pnlSOL = currentSolValue - solSpent;
          const pnlPercent = (pnlSOL / solSpent) * 100;

          // Actualizar maxPrice si el precio actual es mayor
          const maxPrice = parseFloat(position.maxPrice || position.entryPrice);
          if (currentPrice > maxPrice) {
            await positionManager.updatePosition(mint, {
              maxPrice: currentPrice,
            });
          }

          // Live updates por Telegram
          const now = Date.now();
          const lastUpd = lastUpdate[mint] || 0;

          if (LIVE_UPDATES && now - lastUpd >= 10000) {
            await sendPnLUpdate(position, currentPrice, pnlPercent, currentSolValue);
            lastUpdate[mint] = now;
          }

          // Evaluar salida
          const exitDecision = await sniperStrategy.shouldExit(
            position,
            currentPrice,
          );

          if (exitDecision.exit) {
            console.log(`\n🚪 EXIT SIGNAL: ${exitDecision.reason.toUpperCase()}`);
            console.log(`   Mint: ${mint.slice(0, 8)}...`);
            console.log(`   ${exitDecision.description}`);
            console.log(
              `   PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${
                pnlSOL >= 0 ? '+' : ''
              }${pnlSOL.toFixed(4)} SOL)`,
            );
            console.log(`   Priority: ${exitDecision.priority || 'N/A'}\n`);

            await executeSell(
              position,
              currentPrice,
              currentSolValue,
              exitDecision.reason,
            );
          }
        } catch (posError) {
          console.error(
            `   ❌ Error monitoring ${position.mint.slice(0, 8)}: ${posError.message}`,
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('❌ Error monitoring positions:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Ejecuta venta de una posición
 */
async function executeSell(position, currentPrice, solReceived, reason) {
  try {
    const sellResult = await tradeExecutor.sellToken(
      position.mint,
      parseInt(position.tokensAmount),
    );

    if (sellResult.success) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';

      console.log(`${mode} SNIPER SELL EXECUTED`);
      console.log(`   SOL received: ${sellResult.solReceived || solReceived}`);
      console.log(`   Signature: ${sellResult.signature}\n`);

      const closedPosition = await positionManager.closePosition(position.mint, {
        exitPrice: currentPrice,
        reason,
        txId: sellResult.signature,
      });

      await candleAnalyzer.clearHistory(position.mint);

      if (process.env.TELEGRAM_OWNER_CHAT_ID && closedPosition) {
        try {
          const emoji = parseFloat(closedPosition.pnlSOL) >= 0 ? '✅' : '❌';
          const modeStr = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const holdTime = (
            (Date.now() - parseInt(position.entryTime)) /
            1000
          ).toFixed(0);
          const entryPrice = parseFloat(position.entryPrice);

          const reasonMap = {
            take_profit: '💰 Take Profit',
            trailing_stop: '📉 Trailing Stop',
            stop_loss: '🛑 Stop Loss',
            max_hold_time: '⏱️ Max Hold Time',
            manual_sell: '👤 Manual Sell',
          };

          const exitReason = reasonMap[reason] || reason.toUpperCase();

          await sendTelegramAlert(
            process.env.TELEGRAM_OWNER_CHAT_ID,
            `${emoji} ${modeStr} SNIPER EXIT: ${exitReason}\n\n` +
              `${position.name || 'Unknown'} (${position.symbol || 'N/A'})\n` +
              `Mint: ${position.mint.slice(0, 16)}...\n` +
              `Hold: ${holdTime}s\n` +
              `\n` +
              `Entry: ${entryPrice.toFixed(12)}\n` +
              `Exit: ${currentPrice.toFixed(12)}\n` +
              `\n` +
              `PnL: ${parseFloat(closedPosition.pnlPercent).toFixed(2)}% ` +
              `(${parseFloat(closedPosition.pnlSOL).toFixed(4)} SOL)`,
            false,
          );
        } catch (e) {}
      }
    } else {
      console.log(`❌ SELL FAILED: ${sellResult.error}\n`);
    }
  } catch (error) {
    console.error('❌ Error executing sell:', error.message);
  }
}

/**
 * Envía actualizaciones de P&L por Telegram
 */
async function sendPnLUpdate(position, currentPrice, pnlPercent, currentSolValue) {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;

  try {
    const entryPrice = parseFloat(position.entryPrice);
    const maxPrice = parseFloat(position.maxPrice || entryPrice);
    const holdTime = ((Date.now() - parseInt(position.entryTime)) / 1000).toFixed(0);
    const solSpent = parseFloat(position.solAmount);
    const pnlSOL = currentSolValue - solSpent;

    const emoji =
      pnlPercent >= 50
        ? '🚀'
        : pnlPercent >= 20
        ? '📈'
        : pnlPercent >= 0
        ? '🟢'
        : pnlPercent >= -5
        ? '🟡'
        : '🔴';

    await sendTelegramAlert(
      chatId,
      `${emoji} SNIPER P&L UPDATE\n\n` +
        `${position.name || 'Unknown'} (${position.symbol || 'N/A'})\n` +
        `Mint: ${position.mint.slice(0, 16)}...\n` +
        `\n` +
        `Entry: ${entryPrice.toFixed(12)}\n` +
        `Current: ${currentPrice.toFixed(12)}\n` +
        `Max: ${maxPrice.toFixed(12)}\n` +
        `\n` +
        `💰 PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% ` +
        `(${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)\n` +
        `⏱️ Hold: ${holdTime}s`,
      true,
    );
  } catch (e) {}
}

// Stats periódicos
setInterval(async () => {
  try {
    const openPositions = await redis.scard('open_positions');
    const pendingSignals = await redis.llen('sniper_signals');

    if (openPositions > 0 || pendingSignals > 0) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      console.log(
        `\n${mode} - Positions: ${openPositions} | Pending: ${pendingSignals}\n`,
      );
    }
  } catch (error) {}
}, 60000);

console.log('🎯 Sniper Monitor started');
console.log(`   Mode: ${DRY_RUN ? '📄 PAPER TRADING' : '💰 LIVE TRADING'}`);
console.log(`   Executor: TradeExecutor via PumpPortal (Pump.fun only)\n`);

Promise.all([processSniperSignals(), monitorOpenPositions()]).catch((error) => {
  console.error('❌ Sniper monitor crashed:', error.message);
  process.exit(1);
});
