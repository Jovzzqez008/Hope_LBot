// telegram.js - Copy Trading Bot (PnL serio + DRY_RUN + Hybrid Strategy)

import TelegramBot from 'node-telegram-bot-api';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID =
  process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

let bot;
let redis;
const priceService = getPriceService();

function isOwner(chatId) {
  if (!OWNER_CHAT_ID) return true;
  return chatId.toString() === OWNER_CHAT_ID.toString();
}

async function safeSend(chatId, text, silent = false) {
  if (!bot || !chatId) return false;

  try {
    const cleanText = text
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/_/g, '')
      .replace(/\[/g, '')
      .replace(/\]/g, '');

    await bot.sendMessage(chatId, cleanText, {
      disable_notification: silent,
    });
    return true;
  } catch (error) {
    console.log('⚠️ Telegram send error:', error?.message || String(error));
    return false;
  }
}

export async function initTelegram() {
  if (!BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN not set - Telegram disabled');
    return;
  }

  try {
    if (!redis && process.env.REDIS_URL) {
      redis = new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryDelayOnFailover: 100,
      });

      redis.on('error', (err) => {
        console.log('⚠️ Telegram Redis error:', err?.message || String(err));
      });
    }

    bot = new TelegramBot(BOT_TOKEN, {
      polling: true,
      request: {
        agentOptions: {
          keepAlive: true,
          family: 4,
        },
      },
    });

    const dryRun =
      (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';
    const mode = dryRun ? '📝 PAPER (DRY_RUN)' : '💰 LIVE';

    console.log('✅ Telegram bot initialized');
    console.log(`   Mode: ${mode}`);

    // ═════════════════════════════════════════════════════
    // /start - Help
    // ═════════════════════════════════════════════════════
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) {
        return bot.sendMessage(chatId, '⛔ Unauthorized');
      }

      const envMode =
        (process.env.DRY_RUN || '').trim().toLowerCase() === 'false'
          ? '💰 LIVE'
          : '📝 PAPER (DRY_RUN)';

      await safeSend(
        chatId,
        `💼 Pump.fun Copy Trading Bot\n\n` +
          `Mode: ${envMode}\n\n` +
          `📊 General:\n` +
          `/status    - Estado del bot + P&L abierto (copy)\n` +
          `/positions - Posiciones abiertas (copy trading)\n` +
          `/stats     - Rendimiento de hoy (realizado)\n\n` +
          `👁️ Wallets:\n` +
          `/wallets           - Ver wallets copiadas\n` +
          `/addwallet <addr>  - Añadir wallet\n` +
          `/removewallet <addr> - Quitar wallet\n\n` +
          `💰 Gestión manual (Copy Trading):\n` +
          `/sell MINT  - Cerrar UNA posición de copy (simulado, sin TX)\n` +
          `/sell_all   - Cerrar TODAS las posiciones de copy (simulado)\n\n` +
          `ℹ️ Este bot está orientado a COPY TRADING con estrategia HYBRID (Phase 1-3).\n` +
          `Auto-exits y trailing se manejan desde el motor de copy (copyMonitor + copyStrategy).`,
      );
    });

    // ═════════════════════════════════════════════════════
    // /status - Estado general + PnL abierto
    // ═════════════════════════════════════════════════════
    bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const dryRunStatus =
          (process.env.DRY_RUN || '').trim().toLowerCase() === 'false'
            ? '💰 LIVE'
            : '📝 PAPER';
        const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);

        const { RiskManager } = await import('./riskManager.js');
        const riskManager = RiskManager.createFromEnv(redis);

        // PnL abierto (todas las posiciones, luego filtramos copy)
        const openPnL = await riskManager.getOpenPnL();
        const allOpenPositions = openPnL.positions || [];

        const copyPositions = allOpenPositions.filter(
          (p) =>
            p.entry_strategy === 'copy' ||
            p.entry_strategy === 'copy_trading' ||
            p.strategy === 'copy',
        );

        const unrealizedCopyPnL = copyPositions.reduce(
          (acc, p) => acc + (Number(p.pnlSol) || 0),
          0,
        );

        // Stats diarios (realizado)
        const stats = await riskManager.getDailyStats();

        let statsText = 'No trades today yet';
        if (stats && stats.totalTrades > 0) {
          statsText =
            `Trades: ${stats.totalTrades} (Wins: ${stats.wins}, Losses: ${stats.losses})\n` +
            `Win Rate: ${stats.winRate}\n` +
            `Realized P&L: ${stats.totalPnL} SOL\n` +
            `Avg P&L: ${stats.avgPnL} SOL\n` +
            `Best: ${stats.biggestWin} SOL\n` +
            `Worst: ${stats.biggestLoss} SOL\n` +
            `Profit Factor: ${stats.profitFactor}`;
        }

        await safeSend(
          chatId,
          `📊 Status (Copy Trading)\n\n` +
            `Mode: ${dryRunStatus}\n` +
            `Open Copy Positions: ${copyPositions.length}/${maxPositions}\n` +
            `Total Open Positions (cualquier estrategia): ${allOpenPositions.length}\n\n` +
            `💰 Unrealized P&L (copy only): ${unrealizedCopyPnL.toFixed(
              4,
            )} SOL\n\n` +
            `📈 Today's Performance (realizado):\n` +
            `${statsText}`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /positions - Posiciones abiertas (solo copy trading)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = RiskManager.createFromEnv(redis);
        const openPnL = await riskManager.getOpenPnL();
        const positions = openPnL.positions || []

        const copyPositions = positions.filter(
          (p) =>
            p.entry_strategy === 'copy' ||
            p.entry_strategy === 'copy_trading' ||
            p.strategy === 'copy',
        );

        if (!copyPositions.length) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones abiertas de copy trading en este momento.',
          );
        }

        let message = '📂 Copy Trading - Open Positions\n\n';
        copyPositions.forEach((pos, i) => {
          const entryPrice = Number(pos.entryPrice) || 0;
          const currentPrice = Number(pos.currentPrice || pos.entryPrice) || 0;
          const solAmount = Number(pos.solAmount) || 0;
          const pnlPercent = Number(pos.pnlPercent) || 0;
          const pnlSol = Number(pos.pnlSol) || 0;
          const entryTime = Number(pos.entryTime) || 0;
          const graduated =
            pos.graduated === true || pos.graduated === 'true';

          const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
          const holdTimeSec = entryTime
            ? ((Date.now() - entryTime) / 1000).toFixed(0)
            : '0';
          const gradTag = graduated ? ' 🎓' : '';

          const posNum = i + 1;

          message += `${emoji} Position ${posNum}${gradTag}\n`;
          message += `Mint: ${pos.mint.slice(0, 12)}...\n`;
          message += `Size: ${solAmount.toFixed(4)} SOL\n`;
          message += `Entry: ${entryPrice.toFixed(10)}\n`;
          message += `Current: ${currentPrice.toFixed(10)}\n`;
          message += `PnL: ${pnlPercent.toFixed(2)}% | ${pnlSol.toFixed(
            4,
          )} SOL\n`;
          message += `Hold: ${holdTimeSec}s\n`;
          message += `/sell ${pos.mint.slice(0, 8)}\n\n`;
        });

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /sell - Cerrar UNA posición (simulado, solo copy)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `💰 Manual Sell (Copy)\n\n` +
            `Uso: /sell MINT\n` +
            `- MINT puede ser el mint completo o los primeros 6-8 caracteres.\n` +
            `- El cierre es SIMULADO (no envía transacción on-chain), pero actualiza P&L diario.\n`,
        );
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);

        const openPositions = await positionManager.getOpenPositions();

        const copyPositions = openPositions.filter(
          (p) =>
            p.entry_strategy === 'copy' ||
            p.entry_strategy === 'copy_trading' ||
            p.strategy === 'copy',
        );

        if (!copyPositions.length) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones de copy trading para cerrar.',
          );
        }

        const target = copyPositions.find((p) =>
          p.mint.startsWith(mintArg),
        );

        if (!target) {
          return safeSend(
            chatId,
            `❌ No se encontró posición de copy con mint que empiece por: ${mintArg}`,
          );
        }

        const entryPrice = Number(target.entryPrice) || 0;
        const solAmount = Number(target.solAmount) || 0;
        const tokensAmount = Number(target.tokensAmount) || 0;

        if (!entryPrice || !solAmount || !tokensAmount) {
          return safeSend(
            chatId,
            `❌ Datos incompletos de la posición, no se puede cerrar.`,
          );
        }

        // Precio actual via priceService (curva + Jupiter V3)
        const valueData = await priceService.calculateCurrentValue(
          target.mint,
          tokensAmount,
        );

        let exitPrice = entryPrice;
        let solReceived = solAmount;

        if (valueData && valueData.marketPrice && valueData.solValue) {
          exitPrice = valueData.marketPrice;
          solReceived = valueData.solValue;
        }

        const pnlSol = solReceived - solAmount;
        const pnlPercent =
          entryPrice > 0
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : 0;

        const dryRunLocal =
          (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';

        // Cerrar posición en Redis y registrar trade diario
        const closedTrade = await positionManager.closePosition(target.mint, {
          exitPrice,
          reason: 'telegram_manual_sell',
          txId: dryRunLocal ? 'TELEGRAM_PAPER' : 'TELEGRAM_LIVE_NO_TX',
        });

        const mode = dryRunLocal
          ? '📝 PAPER (SIMULATED)'
          : '💰 LIVE (NO TX)';
        const gradTag = valueData?.graduated ? ' 🎓' : '';

        await safeSend(
          chatId,
          `✅ ${mode} MANUAL SELL${gradTag}\n\n` +
            `Mint: ${target.mint.slice(0, 12)}...\n` +
            `Strategy: COPY\n` +
            `Entry: ${entryPrice.toFixed(10)}\n` +
            `Exit: ${exitPrice.toFixed(10)}\n\n` +
            `💰 PnL: ${pnlPercent.toFixed(2)}%\n` +
            `Amount: ${pnlSol.toFixed(4)} SOL\n`,
        );

        if (closedTrade) {
          console.log(
            `🧾 Telegram manual sell recorded: ${closedTrade.mint} | PnL ${closedTrade.pnlSol} SOL`,
          );
        }
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /sell_all - Cerrar TODAS las posiciones copy (simulado)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/sell_all/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const openPositions = await positionManager.getOpenPositions();

        const copyPositions = openPositions.filter(
          (p) =>
            p.entry_strategy === 'copy' ||
            p.entry_strategy === 'copy_trading' ||
            p.strategy === 'copy',
        );

        if (!copyPositions.length) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones de copy trading para cerrar.',
          );
        }

        let totalPnL = 0;
        let count = 0;

        for (const pos of copyPositions) {
          const entryPrice = Number(pos.entryPrice) || 0;
          const solAmount = Number(pos.solAmount) || 0;
          const tokensAmount = Number(pos.tokensAmount) || 0;

          if (!entryPrice || !solAmount || !tokensAmount) continue;

          const valueData = await priceService.calculateCurrentValue(
            pos.mint,
            tokensAmount,
          );

          let exitPrice = entryPrice;
          let solReceived = solAmount;

          if (valueData && valueData.marketPrice && valueData.solValue) {
            exitPrice = valueData.marketPrice;
            solReceived = valueData.solValue;
          }

          const pnlSol = solReceived - solAmount;
          totalPnL += pnlSol;
          count++;

          await positionManager.closePosition(pos.mint, {
            exitPrice,
            reason: 'telegram_sell_all',
            txId: 'TELEGRAM_BULK',
          });
        }

        await safeSend(
          chatId,
          `✅ MANUAL SELL ALL (COPY)\n\n` +
            `Closed positions: ${count}\n` +
            `Total PnL: ${totalPnL.toFixed(4)} SOL\n\n` +
            `ℹ️ Cierre simulado (no se envían transacciones on-chain).`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /stats - Rendimiento del día (realizado)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = RiskManager.createFromEnv(redis);
        const stats = await riskManager.getDailyStats();

        if (!stats || stats.totalTrades === 0) {
          return safeSend(chatId, '🔭 No trades today yet');
        }

        await safeSend(
          chatId,
          `📊 Copy Trading - Today's Performance\n\n` +
            `Total Trades: ${stats.totalTrades}\n` +
            `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
            `Win Rate: ${stats.winRate}\n\n` +
            `Realized P&L: ${stats.totalPnL} SOL\n` +
            `Avg P&L: ${stats.avgPnL} SOL\n` +
            `Best: ${stats.biggestWin} SOL\n` +
            `Worst: ${stats.biggestLoss} SOL\n` +
            `Profit Factor: ${stats.profitFactor}`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /wallets - listar wallets de copy trading
    // ═════════════════════════════════════════════════════
    bot.onText(/\/wallets/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const wallets = await redis.smembers('copy_wallets');
        if (!wallets || wallets.length === 0) {
          return safeSend(
            chatId,
            '📭 No hay wallets configuradas para copy trading.',
          );
        }

        let text = '👁️ Wallets en seguimiento (copy trading):\n\n';
        for (const w of wallets) {
          text += `• ${w}\n`;
        }

        await safeSend(chatId, text);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error listando wallets: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /addwallet <address> - añadir wallet a Redis
    // ═════════════════════════════════════════════════════
    bot.onText(/\/addwallet(?:\s+([1-9A-HJ-NP-Za-km-z]{32,64}))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      const address = match?.[1]?.trim();
      if (!address) {
        return safeSend(
          chatId,
          '❌ Uso: /addwallet <address>\nEjemplo:\n/addwallet 7Xo123abcdeF1kxxWcC9ygvRvtXjHThqipw',
        );
      }

      try {
        await redis.sadd('copy_wallets', address);
        await safeSend(
          chatId,
          `✅ Wallet añadida para copy trading:\n${address}`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error añadiendo wallet: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /removewallet <address> - quitar wallet de Redis
    // ═════════════════════════════════════════════════════
    bot.onText(/\/removewallet(?:\s+([1-9A-HJ-NP-Za-km-z]{32,64}))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      const address = match?.[1]?.trim();
      if (!address) {
        return safeSend(
          chatId,
          '❌ Uso: /removewallet <address>\nEjemplo:\n/removewallet 7Xo123abcdeF1kxxWcC9ygvRvtXjHThqipw',
        );
      }

      try {
        const removed = await redis.srem('copy_wallets', address);
        if (!removed) {
          return safeSend(
            chatId,
            `ℹ️ Esa wallet no estaba registrada:\n${address}`,
          );
        }

        await safeSend(
          chatId,
          `🗑️ Wallet removida del copy trading:\n${address}`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error removiendo wallet: ${error?.message || String(error)}`,
        );
      }
    });

    console.log('✅ Telegram copy-trading commands registered');
  } catch (error) {
    console.error(
      '❌ Failed to initialize Telegram bot:',
      error?.message || String(error),
    );
  }
}

export async function sendTelegramAlert(chatId, message, silent = false) {
  await safeSend(chatId, message, silent);
}
