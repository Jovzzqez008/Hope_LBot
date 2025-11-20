// utils.js - MIGRADO A PRICE SERVICE
// Este archivo mantiene compatibilidad hacia atrás pero usa el nuevo Price Service
import { getPriceService } from './priceService.js';

const priceService = getPriceService();

// ✅ Export main functions (delegating to Price Service)
export async function getPriceFromBondingCurve(mint, forceFresh = false) {
  return await priceService.getPrice(mint, forceFresh);
}

export async function getPriceWithFallback(mint) {
  return await priceService.getPriceWithFallback(mint);
}

export async function calculateCurrentValue(mint, tokenAmount) {
  return await priceService.calculateCurrentValue(mint, tokenAmount);
}

console.log('💰 Utils module loaded (using Price Service)');
