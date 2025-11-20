// copyMonitor.js - HYBRID smart copy trading monitor (solo COPY TRADING)

import { GraduationHandler } from './graduationHandler.js';
const graduationHandler = new GraduationHandler();
import IORedis from 'ioredis';
import { CopyStrategy } from './copyStrategy.js';
import { sendTelegramAlert } from './telegram.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getPriceService } from './priceService.js';
import { getFlintrMetadata } from './flintrClient.js';

const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
});

const connection = new Connection(process.env.RPC_URL, 'confirmed');
const copyStrategy = new CopyStrategy();
const priceService = getPriceService();

const ENABLE_TRADING = process.env.ENABLE_AUTO_TRADING === 'true';
const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIVE_UPDATES = process.env.TELEGRAM_LIVE_UPDATES !== 'false';

// 🎯 HYBRID STRATEGY CONFIG
const WALLET_EXIT_WINDOW = 180000; // 3 minutes
const LOSS_PROTECTION_WINDOW = 600000; // 10 minutes
const INDEPENDENT_MODE_TIME = 600000; // After 10 min

let tradeExecutor, positionManager;

if (ENABLE_TRADING) {
  try {
    const { PositionManager } = await import('./riskManager.js');
    const { TradeExecutor } = await import('./tradeExecutor.js');

    // ✅ ÚNICO ejecutor: TradeExecutor (PumpPortal / Pump.fun) PAPER + LIVE
    tradeExecutor = new TradeExecutor(
      process.env.PRIVATE_KEY,
      process.env.RPC_URL,
      DRY_RUN,
    );

    positionManager = new PositionManager(redis);

    console.log(`💼 Smart Copy Trading ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'} enabled`);
    console.log(`   Executor: TradeExecutor via PumpPortal (Pump.fun)`);
    console.log(`   🎯 HYBRID exit strategy active\n`);
  } catch (error) {
    console.error('⚠️ Trading init failed:', error.message);
    console.error('   Stack:', error.stack);
    tradeExecutor = null;
    positionManager = null;
  }
}

async function calculateCurrentValue(mint, tokenAmount) {
  try {
    return await priceService.calculateCurrentValue(mint, tokenAmount);
  } catch (error) {
    console.error('   ❌ Error calculating value:', error.message);
    return null;
  }
}

async function checkTrackedWalletSold(mint, walletAddress) {
  try {
    const recentSell = await redis.get(`wallet_sold:${walletAddress}:${mint}`);
    if (recentSell) {
      return {
        sold: true,
        timestamp: parseInt(recentSell),
        cached: true,
      };
    }

    const signatures = await connection.getSignaturesForAddress(
      new PublicKey(walletAddress),
      { limit: 20 },
    );

    for (const sig of signatures) {
      const fiveMinutesAgo = Date.now() - 300000;
      if (sig.blockTime * 1000 < fiveMinutesAgo) break;

      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!tx || !tx.meta || tx.meta.err) continue;

        const postTokenBalances = tx.meta.postTokenBalances || [];
        const preTokenBalances = tx.meta.preTokenBalances || [];

        for (let i = 0; i < postTokenBalances.length; i++) {
          const post = postTokenBalances[i];
          const pre = preTokenBalances.find(
            (p) => p.accountIndex === post.accountIndex,
          );

          if (
            post.mint === mint &&
            pre &&
            post.uiTokenAmount.uiAmount < pre.uiTokenAmount.uiAmount
          ) {
            const sellTime = sig.blockTime * 1000;
            await redis.setex(
              `wallet_sold:${walletAddress}:${mint}`,
              600,
              sellTime.toString(),
            );

            return {
              sold: true,
              timestamp: sellTime,
              signature: sig.signature,
            };
          }
        }
      } catch (txError) {
        continue;
      }
    }

    return { sold: false };
  } catch (error) {
    console.error('   ⚠️ Error checking wallet sell:', error.message);
    return { sold: false };
  }
}

async function evaluateHybridExit(position, currentPrice, pnlPercent, currentSolValue) {
  const holdTime = Date.now() - parseInt(position.entryTime);
  const walletAddress = position.walletSource;
  const mint = position.mint;

  const walletSellCheck = await checkTrackedWalletSold(mint, walletAddress);

  if (!walletSellCheck.sold) {
    return { shouldExit: false, phase: 'none' };
  }

  const sellTime = walletSellCheck.timestamp;
  const timeSinceSell = Date.now() - sellTime;

  if (sellTime < parseInt(position.entryTime)) {
    return { shouldExit: false, phase: 'none' };
  }

  if (holdTime < WALLET_EXIT_WINDOW) {
    console.log(`\n⚡ PHASE 1: WALLET EXIT DETECTED (0-3 min)`);
    console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
    );
    console.log(`   🎯 Action: COPY EXIT (early phase)`);

    return {
      shouldExit: true,
      phase: 'phase1',
      reason: 'wallet_exit_early',
      description: `Tracked wallet sold in first 3 minutes`,
      priority: 2,
    };
  }

  if (holdTime >= WALLET_EXIT_WINDOW && holdTime < LOSS_PROTECTION_WINDOW) {
    if (pnlPercent < 0) {
      console.log(`\n🛡️ PHASE 2: WALLET EXIT + LOSS PROTECTION`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(`   Current PnL: ${pnlPercent.toFixed(2)}% (NEGATIVE)`);
      console.log(`   🎯 Action: COPY EXIT (protect loss)`);

      return {
        shouldExit: true,
        phase: 'phase2',
        reason: 'wallet_exit_loss_protection',
        description: `Wallet sold and position is negative (${pnlPercent.toFixed(
          2,
        )}%)`,
        priority: 2,
      };
    } else {
      console.log(`\n✋ PHASE 2: WALLET SOLD BUT HOLDING`);
      console.log(`   Hold time: ${Math.floor(holdTime / 1000)}s`);
      console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
      console.log(`   Current PnL: +${pnlPercent.toFixed(2)}% (POSITIVE)`);
      console.log(`   🎯 Action: IGNORE wallet exit, use trailing stop`);

      return { shouldExit: false, phase: 'phase2_holding' };
    }
  }

  if (holdTime >= INDEPENDENT_MODE_TIME) {
    console.log(`\n✅ PHASE 3: INDEPENDENT MODE`);
    console.log(`   Hold time: ${Math.floor(holdTime / 60000)} minutes`);
    console.log(`   Wallet sold ${Math.floor(timeSinceSell / 1000)}s ago`);
    console.log(
      `   Current PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`,
    );
    console.log(`   🎯 Action: IGNORE wallet exit, using trailing stop`);

    return { shouldExit: false, phase: 'phase3_independent' };
  }

  return { shouldExit: false, phase: 'unknown' };
}

async function processCopySignals() {
  console.log('🎯 Copy signals processor started\n');

  while (true) {
    try {
      const signalJson = await Promise.race([
        redis.lpop('copy_signals'),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const copySignal = JSON.parse(signalJson);

      console.log(`\n🔥 Processing copy signal from ${copySignal.walletName}`);
      console.log(`   Mint: ${copySignal.mint.slice(0, 8)}...`);
      console.log(`   Upvotes: ${copySignal.upvotes}`);

      const decision = await copyStrategy.shouldCopy(copySignal);

      if (!decision.copy) {
        console.log(`   ❌ Copy rejected: ${decision.reason}\n`);
        continue;
      }

      const priceData = await priceService.getPrice(copySignal.mint, true);

      if (!priceData || !priceData.price) {
        console.log(`   ❌ Could not get price\n`);
        continue;
      }

      const currentPrice = priceData.price;

      console.log(`   💰 Executing ${decision.mode} trade...`);
      console.log(`   💵 Price: $${currentPrice.toFixed(10)}`);
      console.log(`   📊 Amount: ${decision.amount.toFixed(4)} SOL`);

      if (ENABLE_TRADING && tradeExecutor) {
        // ✅ Ahora usamos TradeExecutor (PumpPortal/Pump.fun)
        const buyResult = await tradeExecutor.buyToken(
          copySignal.mint,
          decision.amount,
        );

        if (buyResult.success) {
          const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const executedDex = 'Pump.fun';

          console.log(`${mode} BUY EXECUTED via PumpPortal (${executedDex})`);
          console.log(`   Tokens: ${buyResult.tokensReceived}`);
          console.log(`   Signature: ${buyResult.signature}\n`);

          await positionManager.openPosition(
            copySignal.mint,
            'COPY',
            currentPrice,
            decision.amount,
            buyResult.tokensReceived,
            buyResult.signature,
          );

          // 🔍 Intentar enriquecer la posición con metadata de Flintr
          let flintrMeta = null;
          try {
            flintrMeta = await getFlintrMetadata(copySignal.mint, redis);
          } catch {
            flintrMeta = null;
          }

          const basePositionFields = {
            strategy: 'copy',
            walletSource: copySignal.walletAddress,
            walletName: copySignal.walletName,
            upvotes: decision.upvotes.toString(),
            buyers: JSON.stringify(decision.buyers || []),
            originalSignature: copySignal.signature,
            originalDex: copySignal.dex,
            executedDex, // siempre Pump.fun vía PumpPortal
            confidence: decision.confidence.toString(),
            exitStrategy: 'hybrid_smart_exit',
          };

          const flintrFields =
            flintrMeta && Object.keys(flintrMeta).length > 0
              ? {
                  flintr_name: flintrMeta.name || '',
                  flintr_symbol: flintrMeta.symbol || '',
                  flintr_image: flintrMeta.image || '',
                  flintr_description: flintrMeta.description || '',
                  flintr_creator: flintrMeta.creator || '',
                  flintr_decimals: flintrMeta.decimals || '',
                  flintr_mintDatetime: flintrMeta.mintDatetime || '',
                  flintr_bondingCurve: flintrMeta.bondingCurve || '',
                  flintr_associatedBondingCurve:
                    flintrMeta.associatedBondingCurve || '',
                  flintr_marketCapInSOL: flintrMeta.marketCapInSOL || '',
                  flintr_pumpTrades: flintrMeta.pumpTrades || '',
                  flintr_pumpLikes: flintrMeta.pumpLikes || '',
                  flintr_pumpReplies: flintrMeta.pumpReplies || '',
                }
              : {};

          await redis.hset(`position:${copySignal.mint}`, {
            ...basePositionFields,
            ...flintrFields,
          });

          await redis.setex(`copy_cooldown:${copySignal.mint}`, 60, '1');

          if (process.env.TELEGRAM_OWNER_CHAT_ID) {
            try {
              const confidenceEmoji =
                decision.confidence >= 80
                  ? '🔥'
                  : decision.confidence >= 60
                  ? '🟢'
                  : '🟡';

              const dexEmoji = '🚀'; // Pump.fun

              await sendTelegramAlert(
                process.env.TELEGRAM_OWNER_CHAT_ID,
                `${confidenceEmoji} SMART COPY BUY\n\n` +
                  `Trader: ${copySignal.walletName}\n` +
                  `Token: ${copySignal.mint.slice(0, 16)}...\n` +
                  `\n` +
                  `${dexEmoji} Bought on: ${executedDex}\n` +
                  `${
                    copySignal.dex && copySignal.dex !== executedDex
                      ? `Original DEX: ${copySignal.dex}\n`
                      : ''
                  }` +
                  `Price: $${currentPrice.toFixed(10)}\n` +
                  `Amount: ${decision.amount.toFixed(4)} SOL\n` +
                  `\n` +
                  `Upvotes: ${decision.upvotes} wallet(s)\n` +
                  `Confidence: ${decision.confidence}%\n` +
                  `\n` +
                  `🎯 HYBRID Exit Strategy:\n` +
                  `• 0-3 min: Copy wallet exits\n` +
                  `• 3-10 min: Copy only on loss\n` +
                  `• 10+ min: Independent trading\n` +
                  `• Take Profit: +${
                    process.env.COPY_PROFIT_TARGET || 200
                  }%\n` +
                  `• Trailing Stop: -${
                    process.env.TRAILING_STOP || 35
                  }%\n` +
                  `• Stop Loss: -${process.env.COPY_STOP_LOSS || 25}%`,
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
      console.error('❌ Error processing copy signal:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function processSellSignals() {
  while (true) {
    try {
      const signalJson = await redis.lpop('sell_signals');

      if (!signalJson) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const sellSignal = JSON.parse(signalJson);
      const { mint, sellCount, sellers } = sellSignal;

      console.log(`\n📉 Processing sell signal for ${mint.slice(0, 8)}...`);
      console.log(`   Sellers: ${sellCount}`);

      const hasPosition = await redis.sismember('open_positions', mint);

      if (!hasPosition) {
        console.log(`   ⭕️ No position in this token\n`);
        continue;
      }

      const position = await redis.hgetall(`position:${mint}`);

      if (!position || position.strategy !== 'copy') {
        continue;
      }

      const minToSell = parseInt(process.env.MIN_WALLETS_TO_SELL || '1');

      if (sellCount >= minToSell) {
        console.log(`   🚨 ${sellCount}/${minToSell} wallets sold - FLAGGING FOR REVIEW`);

        await redis.setex(`multiple_sellers:${mint}`, 30, sellCount.toString());

        if (process.env.TELEGRAM_OWNER_CHAT_ID) {
          try {
            await sendTelegramAlert(
              process.env.TELEGRAM_OWNER_CHAT_ID,
              `⚠️ MULTIPLE TRADERS SELLING\n\n` +
                `Token: ${mint.slice(0, 16)}...\n` +
                `Sellers: ${sellCount}/${minToSell} wallets\n` +
                `\n` +
                `Hybrid strategy will evaluate exit...`,
              false,
            );
          } catch (e) {}
        }
      } else {
        console.log(`   ⏳ Only ${sellCount}/${minToSell} wallets sold - waiting\n`);
      }
    } catch (error) {
      console.error('❌ Error processing sell signal:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function monitorOpenPositions() {
  let lastUpdate = {};

  while (true) {
    try {
      if (!ENABLE_TRADING || !tradeExecutor || !positionManager) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      const openPositions = await positionManager.getOpenPositions();

      for (const position of openPositions) {
        if (position.strategy !== 'copy') {
          continue;
        }

        const tokensAmount = parseInt(position.tokensAmount);
        const valueData = await calculateCurrentValue(position.mint, tokensAmount);

        if (!valueData) {
          console.log(
            `   ⚠️ Could not get current value for ${position.mint.slice(0, 8)}`,
          );
          continue;
        }

        const currentPrice = valueData.marketPrice;
        const entryPrice = parseFloat(position.entryPrice);
        const solSpent = parseFloat(position.solAmount);

        const currentSolValue = valueData.solValue;
        const pnlSOL = currentSolValue - solSpent;
        const pnlPercent = (pnlSOL / solSpent) * 100;

        const maxPrice = parseFloat(position.maxPrice || position.entryPrice);
        if (currentPrice > maxPrice) {
          await positionManager.updateMaxPrice(position.mint, currentPrice);
        }

        const now = Date.now();
        const lastUpd = lastUpdate[position.mint] || 0;

        if (LIVE_UPDATES && now - lastUpd >= 5000) {
          await sendPnLUpdate(position, currentPrice, pnlPercent, currentSolValue);
          lastUpdate[position.mint] = now;
        }

        const forceExit = await redis.get(`force_exit:${position.mint}`);

        if (forceExit) {
          await redis.del(`force_exit:${position.mint}`);

          console.log(`\n🎓 FORCE EXIT: Graduation detected`);
          console.log(`   Reason: ${forceExit}`);
          console.log(
            `   PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(`   Priority: 1 (Graduation override)\n`);

          await executeSell(position, currentPrice, currentSolValue, forceExit);
          continue;
        }

        const hybridExit = await evaluateHybridExit(
          position,
          currentPrice,
          pnlPercent,
          currentSolValue,
        );

        if (hybridExit.shouldExit) {
          console.log(`\n🎯 HYBRID EXIT: ${hybridExit.reason.toUpperCase()}`);
          console.log(`   ${hybridExit.description}`);
          console.log(
            `   PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${
              pnlSOL >= 0 ? '+' : ''
            }${pnlSOL.toFixed(4)} SOL)`,
          );
          console.log(`   Priority: ${hybridExit.priority}\n`);

          await executeSell(position, currentPrice, currentSolValue, hybridExit.reason);
          continue;
        }

        const exitDecision = await copyStrategy.shouldExit(
          position,
          currentPrice,
        );

        if (exitDecision.exit) {
          console.log(`\n🚪 EXIT SIGNAL: ${exitDecision.reason.toUpperCase()}`);
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
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('❌ Error monitoring positions:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function executeSell(position, currentPrice, solReceived, reason) {
  try {
    // Siempre vendemos vía PumpPortal / Pump.fun
    const sellResult = await tradeExecutor.sellToken(
      position.mint,
      parseInt(position.tokensAmount),
    );

    if (sellResult.success) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      const executedDex = 'Pump.fun';

      console.log(`${mode} SELL EXECUTED via PumpPortal (${executedDex})`);
      console.log(`   SOL received: ${sellResult.solReceived}`);
      console.log(`   Signature: ${sellResult.signature}\n`);

      const closedPosition = await positionManager.closePosition(
        position.mint,
        currentPrice,
        parseInt(position.tokensAmount),
        sellResult.solReceived,
        reason,
        sellResult.signature,
      );

      await redis.del(
        `wallet_sold:${position.walletSource}:${position.mint}`,
      );

      if (process.env.TELEGRAM_OWNER_CHAT_ID && closedPosition) {
        try {
          const emoji =
            parseFloat(closedPosition.pnlSOL) >= 0 ? '✅' : '❌';
          const modeStr = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
          const holdTime = (
            (Date.now() - parseInt(position.entryTime)) /
            1000
          ).toFixed(0);
          const entryPrice = parseFloat(position.entryPrice);

          const reasonMap = {
            wallet_exit_early: '⚡ Phase 1: Wallet Exit (0-3 min)',
            wallet_exit_loss_protection:
              '🛡️ Phase 2: Wallet Exit + Loss Protection',
            take_profit: '💰 Take Profit',
            trailing_stop: '📉 Trailing Stop',
            stop_loss: '🛑 Stop Loss',
            traders_sold: '💼 Multiple Traders Sold',
            traders_sold_auto: '💼 Traders Auto-Sell',
            max_hold_time: '⏱️ Max Hold Time',
            manual_sell: '👤 Manual Sell',
          };

          const exitReason = reasonMap[reason] || reason.toUpperCase();

          await sendTelegramAlert(
            process.env.TELEGRAM_OWNER_CHAT_ID,
            `${emoji} ${modeStr} EXIT: ${exitReason}\n\n` +
              `Trader: ${position.walletName || 'Unknown'}\n` +
              `Token: ${position.mint.slice(0, 16)}...\n` +
              `Hold: ${holdTime}s\n` +
              `\n` +
              `Entry: ${entryPrice.toFixed(10)}\n` +
              `Exit: ${currentPrice.toFixed(10)}\n` +
              `\n` +
              `PnL: ${parseFloat(closedPosition.pnlPercent).toFixed(
                2,
              )}% ` +
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

// ✅ P&L live updates por Telegram
async function sendPnLUpdate(position, currentPrice, pnlPercent, currentSolValue) {
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!chatId) return;

  try {
    const entryPrice = parseFloat(position.entryPrice);
    const maxPrice = parseFloat(position.maxPrice || entryPrice);
    const holdTime = (
      (Date.now() - parseInt(position.entryTime)) /
      1000
    ).toFixed(0);
    const upvotes = parseInt(position.upvotes || '1');
    const solSpent = parseFloat(position.solAmount);
    const pnlSOL = currentSolValue - solSpent;

    const sellCount =
      (await redis.scard(`upvotes:${position.mint}:sellers`)) || 0;
    const minToSell = parseInt(process.env.MIN_WALLETS_TO_SELL || '1');

    const holdTimeMs = Date.now() - parseInt(position.entryTime);
    let phaseInfo = '';
    if (holdTimeMs < WALLET_EXIT_WINDOW) {
      phaseInfo = '⚡ Phase 1: Following wallet';
    } else if (holdTimeMs < LOSS_PROTECTION_WINDOW) {
      phaseInfo =
        pnlPercent < 0
          ? '🛡️ Phase 2: Loss protection active'
          : '🟢 Phase 2: Letting it run';
    } else {
      phaseInfo = '🚀 Phase 3: Independent mode';
    }

    const emoji =
      pnlPercent >= 20
        ? '🚀'
        : pnlPercent >= 10
        ? '📈'
        : pnlPercent >= 0
        ? '🟢'
        : pnlPercent >= -5
        ? '🟡'
        : '🔴';

    await sendTelegramAlert(
      chatId,
      `${emoji} P&L UPDATE\n\n` +
        `Mint: ${position.mint.slice(0, 16)}...\n` +
        `Entry: $${entryPrice.toFixed(10)}\n` +
        `Current: $${currentPrice.toFixed(10)}\n` +
        `Max: $${maxPrice.toFixed(10)}\n` +
        `\n` +
        `💰 PnL: ${
          pnlPercent >= 0 ? '+' : ''
        }${pnlPercent.toFixed(2)}% ` +
        `(${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL)\n` +
        `⏱️ Hold: ${holdTime}s\n` +
        `🎯 Upvotes: ${upvotes}\n` +
        `📉 Sellers: ${sellCount}/${minToSell}\n` +
        `\n` +
        `${phaseInfo}`,
      true,
    );
  } catch (e) {}
}

setInterval(async () => {
  try {
    const openPositions = await redis.scard('open_positions');
    const pendingSignals = await redis.llen('copy_signals');

    if (openPositions > 0 || pendingSignals > 0) {
      const mode = DRY_RUN ? '📄 PAPER' : '💰 LIVE';
      console.log(
        `\n${mode} - Positions: ${openPositions} | Pending: ${pendingSignals}\n`,
      );
    }
  } catch (error) {}
}, 60000);

console.log('🚀 Copy Monitor HYBRID strategy started');
console.log(
  `   Mode: ${DRY_RUN ? '📄 PAPER TRADING' : '💰 LIVE TRADING'}`,
);
console.log(
  `   Executor: TradeExecutor via PumpPortal (Pump.fun only, COPY TRADING)`,
);
console.log(`   🎯 HYBRID exit: Phase 1-3 with trailing stop\n`);

Promise.all([
  processCopySignals(),
  processSellSignals(),
  monitorOpenPositions(),
]).catch((error) => {
  console.error('❌ Copy monitor crashed:', error.message);
  process.exit(1);
});
