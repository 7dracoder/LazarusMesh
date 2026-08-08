'use strict';

const PAYMENT_RAILS = Object.freeze({
  X402_MONAD: 'x402_monad',
  RAIN_CARD: 'rain_card',
  RAIN_PAYMENT: 'rain_payment',
});

/**
 * Select the first supported payment rail using the product's fixed routing
 * order: native digital payment, card purchase, then local/bank payout.
 *
 * @param {{sellerSupportsX402?: boolean, sellerAcceptsCard?: boolean,
 *   sellerHasRainPayoutRoute?: boolean, isDigitalResource?: boolean,
 *   requiresChargebackProtection?: boolean, allowedRails?: string[]}} input
 * @returns {'x402_monad'|'rain_card'|'rain_payment'}
 * @throws {Error} with code `NO_SUPPORTED_PAYMENT_RAIL`
 */
function selectRail(input = {}) {
  const allowed = input.allowedRails === undefined
    ? null
    : new Set(input.allowedRails);
  const permits = (rail) => allowed === null || allowed.has(rail);

  if (
    input.sellerSupportsX402 === true &&
    input.isDigitalResource === true &&
    input.requiresChargebackProtection !== true &&
    permits(PAYMENT_RAILS.X402_MONAD)
  ) {
    return PAYMENT_RAILS.X402_MONAD;
  }

  if (input.sellerAcceptsCard === true && permits(PAYMENT_RAILS.RAIN_CARD)) {
    return PAYMENT_RAILS.RAIN_CARD;
  }

  if (
    input.sellerHasRainPayoutRoute === true &&
    permits(PAYMENT_RAILS.RAIN_PAYMENT)
  ) {
    return PAYMENT_RAILS.RAIN_PAYMENT;
  }

  const error = new Error('NO_SUPPORTED_PAYMENT_RAIL');
  error.code = 'NO_SUPPORTED_PAYMENT_RAIL';
  throw error;
}

module.exports = {
  PAYMENT_RAILS,
  selectRail,
};
