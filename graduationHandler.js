// graduationHandler.js - Detecta graduación y marca posiciones (copy trading)
// ✅ Usa priceService (bonding curve + Jupiter V3)
// ✅ Marca la posición como graduada en Redis
// ✅ Opcional: dispara force_exit para que copyMonitor venda

import IORedis from 'ioredis';
import { Connection } from '@solana/web3.js';
import { getPriceService } from './priceService.js';
import { PositionManager } from './riskManager.js';
import { sendTelegramAlert } from './telegram.js';

const REDIS_URL = process.env.REDIS_URL || null;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

const CHECK_INTERVAL_MS = parseInt(
  process.env.GRADUATION_CHECK_INTERVAL_MS || '15000',
  10,
);

const AUTO_SELL_ON_GRADUATION = (() => {
  const v = (process.env.AUTO_SELL_ON_GRADUATION || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
})();

export class GraduationHandler {
  constructor(redisClient) {
    if (!REDIS_URL && !redisClient) {
      throw new Error('REDIS_URL no configurado para GraduationHandler');
    }

    this.redis =
      redisClient ||
      new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
      });

    this.connection = new Connection(RPC_URL, 'confirmed');
    this.priceService = getPriceService();
    this.positionManager = new PositionManager(this.redis);

    this.running = false;
    this.intervalId = null;

    console.log('🎓 GraduationHandler inicializado');
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   Check interval: ${CHECK_INTERVAL_MS} ms`);
    console.log(
      `   AUTO_SELL_ON_GRADUATION: ${AUTO_SELL_ON_GRADUATION ? 'ON' : 'OFF'}`,
    );
  }

  /**
   * Inicia el loop de monitoreo de graduación.
   * Debes llamarlo una sola vez desde tu proceso (server/worker de copy).
   */
  start() {
    if (this.running) return;
    this.running = true;

    console.log('🎓 GraduationHandler STARTED (monitoring open copy positions)\n');

    this.intervalId = setInterval(async () => {
      try {
        await this._checkGraduations();
      } catch (error) {
        console.error('❌ Error en GraduationHandler loop:', error?.message);
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Detiene el loop (por si quieres apagar el proceso elegantemente).
   */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId) clearInterval(this.intervalId);
    console.log('🛑 GraduationHandler STOPPED');
  }

  /**
   * Recorre posiciones abiertas y detecta cuáles ya se graduaron.
   */
  async _checkGraduations() {
    const openPositions = await this.positionManager.getOpenPositions();
    if (!openPositions || openPositions.length === 0) {
      return;
    }

    for (const pos of openPositions) {
      // Solo nos interesan posiciones de COPY TRADING
      const strategy =
        pos.entry_strategy || pos.strategy || pos.source || 'unknown';

      if (strategy !== 'copy' && strategy !== 'copy_trading') {
        continue;
      }

      // Si ya está marcada como graduada, no repetimos trabajo
      if (pos.graduated === true || pos.graduated === 'true') {
        continue;
      }

      const mint = pos.mint;
      if (!mint) continue;

      try {
        console.log(
          `\n🎓 Revisando graduación para ${mint.slice(0, 8)}... (wallet: ${
            pos.wallet || pos.walletSource || 'unknown'
          })`,
        );

        // 1) Preguntar a priceService si la curva de Pump.fun ya está completa
        const gradInfo = await this.priceService.hasGraduated(mint);

        if (!gradInfo.graduated) {
          console.log(
            `   ⏳ Aún en bonding curve: ${gradInfo.reason || 'curve_open'}`,
          );
          continue;
        }

        console.log(
          `   ✅ Curva de Pump.fun completada (graduated: ${gradInfo.reason})`,
        );

        // 2) Intentar obtener precio desde DEX (Jupiter V3)
        const dexPriceData = await this.priceService.getPriceFromDEX(mint);
        let graduationPrice = 0;
        let graduationSource = 'unknown';

        if (dexPriceData && dexPriceData.price && dexPriceData.price > 0) {
          graduationPrice = dexPriceData.price;
          graduationSource = dexPriceData.source || 'jupiter_v3';
          console.log(
            `   💰 Precio DEX (Jupiter V3): ${graduationPrice.toFixed(12)} SOL`,
          );
        } else {
          // Si aún no hay precio en Jupiter, usamos entryPrice como placeholder
          graduationPrice = pos.entryPrice || 0;
          graduationSource = 'entry_fallback';
          console.log(
            `   ⚠️ Jupiter aún no indexa el token. Usando entryPrice como fallback: ${graduationPrice}`,
          );
        }

        // 3) Guardar marca de graduación en la posición
        const now = Date.now();
        const updateData = {
          graduated: 'true',
          graduationPrice: String(graduationPrice),
          graduationSource,
          graduationTime: String(now),
        };

        await this.redis.hset(`position:${mint}`, updateData);

        console.log(
          `   📝 Posición marcada como graduada (graduationPrice: ${graduationPrice})`,
        );

        // 4) Opcional: disparar auto-exit mediante "force_exit"
        if (AUTO_SELL_ON_GRADUATION) {
          const reasonKey = 'graduation_auto_exit';
          await this.redis.setex(
            `force_exit:${mint}`,
            60, // 1 minuto de ventana para que copyMonitor la procese
            reasonKey,
          );
          console.log(
            `   🚨 AUTO_SELL_ON_GRADUATION activo → force_exit:${mint}=${reasonKey}`,
          );
        }

        // 5) Telegram opcional
        const chatId = process.env.TELEGRAM_OWNER_CHAT_ID;
        if (chatId) {
          try {
            const entryPrice = Number(pos.entryPrice || 0);
            const tokensAmount = Number(pos.tokensAmount || 0);
            const solAmount = Number(pos.solAmount || 0);

            let text =
              `🎓 TOKEN GRADUATED\n\n` +
              `Mint: ${mint.slice(0, 16)}...\n` +
              `Wallet: ${pos.wallet || pos.walletSource || 'Unknown'}\n` +
              `\n` +
              `Entry Price: ${
                entryPrice ? entryPrice.toFixed(10) : 'N/A'
              } SOL\n` +
              `Graduation Price: ${
                graduationPrice ? graduationPrice.toFixed(10) : 'N/A'
              } SOL\n` +
              `Source: ${graduationSource}\n` +
              `\n` +
              `Size: ${solAmount.toFixed(4)} SOL | Tokens: ${tokensAmount.toLocaleString()}\n`;

            if (AUTO_SELL_ON_GRADUATION) {
              text +=
                `\n` +
                `🛑 AUTO_SELL_ON_GRADUATION: ON\n` +
                `Bot will trigger an exit (force_exit) on next copyMonitor tick.`;
            } else {
              text +=
                `\n` +
                `ℹ️ Position will now be monitored on DEX (Jupiter V3).\n` +
                `Exit will follow HYBRID strategy / trailing / TP / SL.`;
            }

            await sendTelegramAlert(chatId, text, false);
          } catch (e) {
            console.log('⚠️ Error enviando alerta de graduación por Telegram');
          }
        }
      } catch (error) {
        console.error(
          `   ❌ Error procesando graduación de ${pos.mint}:`,
          error?.message || String(error),
        );
      }
    }
  }
}

// Helper simple para iniciar desde otro módulo (server/worker)
export function startGraduationWatcher(redisClient) {
  const handler = new GraduationHandler(redisClient);
  handler.start();
  return handler;
}

console.log('🎓 graduationHandler.js loaded');
