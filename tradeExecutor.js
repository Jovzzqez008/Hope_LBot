// tradeExecutor.js - MEJORADO con trading LIVE para Pump.fun (PumpPortal Local API)
// ✅ Soporte LIVE via PumpPortal /trade-local
// ✅ DRY_RUN con simulación usando priceService (curva + Jupiter V3)
// ✅ Retry automático en transacciones
// ✅ Slippage dinámico
// ✅ Priority fees configurables
// ✅ Validaciones pre-trade

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getPriceService } from './priceService.js';

const priceService = getPriceService();

const PUMPPORTAL_API = 'https://pumpportal.fun/api';
const MAX_TX_RETRIES = 3;
const TX_RETRY_DELAY_MS = 2000;
const TX_CONFIRMATION_TIMEOUT = 60_000; // 60s

export class TradeExecutor {
  constructor(privateKey, rpcUrl, dryRun = true) {
    this.dryRun = !!dryRun;
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, 'confirmed');

    // Solo parsear keypair si NO está en DRY_RUN
    if (!this.dryRun && privateKey) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        console.log(`💼 Wallet cargada: ${this.wallet.publicKey.toBase58()}`);
      } catch (error) {
        console.error('❌ Error cargando wallet:', error?.message);
        throw new Error('Invalid PRIVATE_KEY format');
      }
    } else {
      this.wallet = null;
    }

    // Configuración de fees
    this.priorityFee = parseFloat(process.env.PRIORITY_FEE || '0.00005');
    this.computeUnitLimit = parseInt(process.env.COMPUTE_UNIT_LIMIT || '800000', 10);
    this.computeUnitPrice = parseInt(
      process.env.COMPUTE_UNIT_PRICE_MICROLAMPORTS || '5000',
      10,
    );

    // Slippage
    this.slippageBuyPct = parseFloat(process.env.PUMP_SLIPPAGE_PERCENT_BUY || '10');
    this.slippageSellPct = parseFloat(process.env.PUMP_SLIPPAGE_PERCENT_SELL || '10');

    console.log(`🔧 TradeExecutor inicializado:`);
    console.log(`   Modo: ${this.dryRun ? 'PAPER' : 'LIVE'}`);
    console.log(`   Priority Fee: ${this.priorityFee} SOL`);
    console.log(
      `   Slippage: Buy ${this.slippageBuyPct}% / Sell ${this.slippageSellPct}%`,
    );
  }

  // ═══════════════════════════════════════════════════════
  // BUY TOKEN
  // ═══════════════════════════════════════════════════════
  async buyToken(mint, solAmount, _dex = 'pump', slippage = null) {
    if (!mint || !solAmount || solAmount <= 0) {
      return { success: false, error: 'invalid_parameters' };
    }

    if (this.dryRun) {
      return await this._buyTokenPaper(mint, solAmount);
    }

    return await this._buyTokenLive(mint, solAmount, slippage);
  }

  /**
   * BUY PAPER - Simulación usando priceService
   */
  async _buyTokenPaper(mint, solAmount) {
    try {
      console.log(`\n📄 [PAPER] Simulando BUY ${solAmount} SOL en ${mint.slice(0, 8)}...`);

      const priceData = await priceService.getPriceWithFallback(mint);

      if (!priceData || !priceData.price || priceData.price <= 0) {
        console.log('   ❌ No se pudo obtener precio para simulación');
        return {
          success: false,
          simulated: true,
          dryRun: true,
          error: 'no_price_for_simulation',
        };
      }

      const entryPrice = priceData.price;
      const tokensReceived = solAmount / entryPrice;

      console.log(
        `   ✅ [PAPER] ${tokensReceived.toLocaleString()} tokens @ ${entryPrice.toFixed(
          12,
        )} (${priceData.source})`,
      );

      return {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        solSpent: solAmount,
        tokensReceived,
        entryPrice,
        dex: priceData.graduated ? 'dex_jupiter' : 'pumpfun_curve',
        source: priceData.source,
        signature: `paper_buy_${Date.now()}`,
      };
    } catch (error) {
      console.error('❌ Error en _buyTokenPaper:', error?.message);
      return {
        success: false,
        simulated: true,
        dryRun: true,
        error: error?.message || 'paper_buy_error',
      };
    }
  }

  /**
   * BUY LIVE - Real via PumpPortal /trade-local
   */
  async _buyTokenLive(mint, solAmount, slippage = null) {
    if (!this.wallet) {
      console.error('❌ No wallet configurada para LIVE trading');
      return { success: false, error: 'no_wallet' };
    }

    try {
      console.log(`\n💰 [LIVE] Comprando ${solAmount} SOL de ${mint.slice(0, 8)}...`);

      // 1. Validaciones pre-trade
      const preCheck = await this._preTradeValidation(solAmount);
      if (!preCheck.valid) {
        console.log(`   ❌ Pre-trade validation failed: ${preCheck.reason}`);
        return { success: false, error: preCheck.reason };
      }

      // 2. Precio aproximado para estimar tokens esperados
      const priceData = await priceService.getPriceWithFallback(mint);
      const expectedTokens =
        priceData?.price && priceData.price > 0 ? solAmount / priceData.price : 0;

      // 3. Calcular slippage
      const finalSlippage = slippage ?? this.slippageBuyPct;
      const slippageBps = Math.floor(finalSlippage * 100); // % → basis points

      // 4. Construir transacción via PumpPortal
      const txData = await this._buildBuyTransaction(mint, solAmount, slippageBps);
      if (!txData || !txData.tx) {
        return { success: false, error: 'invalid_pumpportal_response' };
      }

      // 5. Firmar y enviar transacción
      const { signature } = await this._sendAndConfirm(txData.tx);

      console.log(
        `   ✅ [LIVE] BUY enviado: ${signature} (estimado ~${expectedTokens.toLocaleString()} tokens)`,
      );

      return {
        success: true,
        simulated: false,
        dryRun: false,
        mint,
        solSpent: solAmount,
        tokensReceived: expectedTokens, // valor aproximado, el real se puede recalcular luego
        entryPrice: priceData?.price || 0,
        dex: 'pumpportal_local',
        source: priceData?.source || 'pumpfun_bonding_curve',
        signature,
      };
    } catch (error) {
      console.error('❌ Error en _buyTokenLive:', error?.message);
      return {
        success: false,
        error: error?.message || 'live_buy_error',
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // SELL TOKEN
  // ═══════════════════════════════════════════════════════
  async sellToken(mint, tokenAmount, _dex = 'pump', slippage = null) {
    if (!mint || !tokenAmount || tokenAmount <= 0) {
      return { success: false, error: 'invalid_parameters' };
    }

    if (this.dryRun) {
      return await this._sellTokenPaper(mint, tokenAmount);
    }

    return await this._sellTokenLive(mint, tokenAmount, slippage);
  }

  /**
   * SELL PAPER - Simulación usando priceService
   */
  async _sellTokenPaper(mint, tokenAmount) {
    try {
      console.log(
        `\n📄 [PAPER] Simulando SELL de ${tokenAmount.toLocaleString()} tokens en ${mint.slice(
          0,
          8,
        )}...`,
      );

      const valueData = await priceService.calculateCurrentValue(mint, tokenAmount);

      if (!valueData || !valueData.marketPrice || valueData.marketPrice <= 0) {
        console.log('   ❌ No se pudo obtener precio para venta simulada');
        return {
          success: false,
          simulated: true,
          dryRun: true,
          error: 'no_price_for_simulation',
        };
      }

      console.log(
        `   ✅ [PAPER] ${valueData.solValue.toFixed(6)} SOL @ ${valueData.marketPrice.toFixed(
          12,
        )} (${valueData.source})`,
      );

      return {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        tokensSold: tokenAmount,
        solReceived: valueData.solValue,
        exitPrice: valueData.marketPrice,
        source: valueData.source,
        signature: `paper_sell_${Date.now()}`,
      };
    } catch (error) {
      console.error('❌ Error en _sellTokenPaper:', error?.message);
      return {
        success: false,
        simulated: true,
        dryRun: true,
        error: error?.message || 'paper_sell_error',
      };
    }
  }

  /**
   * SELL LIVE - Real via PumpPortal /trade-local
   */
  async _sellTokenLive(mint, tokenAmount, slippage = null) {
    if (!this.wallet) {
      console.error('❌ No wallet configurada para LIVE trading');
      return { success: false, error: 'no_wallet' };
    }

    try {
      console.log(
        `\n💰 [LIVE] Vendiendo ${tokenAmount.toLocaleString()} tokens de ${mint.slice(
          0,
          8,
        )}...`,
      );

      const finalSlippage = slippage ?? this.slippageSellPct;
      const slippageBps = Math.floor(finalSlippage * 100);

      const txData = await this._buildSellTransaction(mint, tokenAmount, slippageBps);
      if (!txData || !txData.tx) {
        return { success: false, error: 'invalid_pumpportal_response' };
      }

      const { signature } = await this._sendAndConfirm(txData.tx);

      console.log(`   ✅ [LIVE] SELL enviado: ${signature}`);

      return {
        success: true,
        simulated: false,
        dryRun: false,
        mint,
        tokensSold: tokenAmount,
        solReceived: null, // Se puede calcular luego con priceService
        exitPrice: null,
        source: 'pumpportal_local',
        signature,
      };
    } catch (error) {
      console.error('❌ Error en _sellTokenLive:', error?.message);
      return {
        success: false,
        error: error?.message || 'live_sell_error',
      };
    }
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS PumpPortal
  // ═══════════════════════════════════════════════════════

  /**
   * Construir transacción de BUY via PumpPortal API (/trade-local)
   */
  async _buildBuyTransaction(mint, solAmount, slippageBps) {
    try {
      const url = `${PUMPPORTAL_API}/trade-local`;

      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'buy',
        mint,
        amount: solAmount,
        denominatedInSol: true,
        slippageBps,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PumpPortal API error (buy): ${errorText}`);
      }

      const data = await response.json();
      return data; // { tx: 'base64-encoded-transaction' }
    } catch (error) {
      console.error('❌ Error building buy transaction:', error?.message);
      throw error;
    }
  }

  /**
   * Construir transacción de SELL via PumpPortal API (/trade-local)
   */
  async _buildSellTransaction(mint, tokenAmount, slippageBps) {
    try {
      const url = `${PUMPPORTAL_API}/trade-local`;

      const payload = {
        publicKey: this.wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: tokenAmount,
        denominatedInSol: false,
        slippageBps,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PumpPortal API error (sell): ${errorText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('❌ Error building sell transaction:', error?.message);
      throw error;
    }
  }

  /**
   * Envía y confirma una transacción en base64 (PumpPortal /trade-local)
   */
  async _sendAndConfirm(base64Tx) {
    const raw = Buffer.from(base64Tx, 'base64');

    let tx;
    try {
      // Intentar como VersionedTransaction
      tx = VersionedTransaction.deserialize(raw);
    } catch {
      // Fallback a Transaction legacy
      tx = Transaction.from(raw);
    }

    // Firmar con tu wallet
    tx.sign(this.wallet);

    const serialized =
      tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize();

    let lastError = null;
    for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
      try {
        const sig = await this.connection.sendRawTransaction(serialized, {
          skipPreflight: false,
          maxRetries: 2,
        });

        const confirmation = await this.connection.confirmTransaction(
          {
            signature: sig,
            ...(await this.connection.getLatestBlockhash()),
          },
          'confirmed',
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return { signature: sig };
      } catch (error) {
        lastError = error;
        console.log(
          `⚠️ Error enviando tx (attempt ${attempt + 1}/${MAX_TX_RETRIES}):`,
          error?.message || String(error),
        );
        if (attempt < MAX_TX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, TX_RETRY_DELAY_MS));
        }
      }
    }

    throw new Error(
      `Transaction failed after ${MAX_TX_RETRIES} attempts: ${
        lastError?.message || 'unknown_error'
      }`,
    );
  }

  /**
   * Validaciones básicas antes de abrir posición LIVE
   */
  async _preTradeValidation(solAmount) {
    if (!this.wallet) {
      return { valid: false, reason: 'no_wallet' };
    }

    if (!solAmount || solAmount <= 0) {
      return { valid: false, reason: 'invalid_amount' };
    }

    const balanceSol = await this._getBalanceSol();
    const buffer = solAmount * 0.05; // 5% buffer para fees, etc.

    if (balanceSol < solAmount + buffer) {
      console.log(
        `   ❌ Balance insuficiente. Balance: ${balanceSol.toFixed(
          4,
        )} SOL, requerido: ${(solAmount + buffer).toFixed(4)} SOL`,
      );
      return { valid: false, reason: 'insufficient_funds' };
    }

    return { valid: true };
  }

  /**
   * Balance actual de la wallet en SOL
   */
  async _getBalanceSol() {
    if (!this.wallet) {
      return 0;
    }

    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('❌ Error obteniendo balance:', error?.message);
      return 0;
    }
  }
}
