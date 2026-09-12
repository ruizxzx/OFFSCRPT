export type CommissionRuleScope = 'global' | 'creator' | 'product';
export type CommissionRuleStatus = 'draft' | 'active' | 'inactive';

export interface CommissionRuleInput {
  scope: CommissionRuleScope;
  productId?: string;
  creatorId?: string;
  percentage?: number;
  fixedAmount?: number;
  minimumAmount?: number;
  maximumAmount?: number;
  currency?: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  priority?: number;
  active?: boolean;
  refundPolicy?: {
    proportional: boolean;
  };
}

export interface CommissionRule {
  id: string;
  ruleId: string;
  ruleVersion: number;
  scope: CommissionRuleScope;
  productId?: string;
  creatorId?: string;
  percentage: number;
  percentageBps: number;
  fixedAmount: number;
  minimumAmount?: number;
  maximumAmount?: number;
  currency: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  active: boolean;
  priority: number;
  refundPolicy: { proportional: boolean };
  createdAt: string;
  updatedAt: string;
}

function finiteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function normalizePercentageBps(value: unknown): number {
  const n = finiteNumber(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Commission percentage must be between 0% and 100%.');
  const bps = Math.round(n * 100);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) throw new Error('Invalid commission percentage precision.');
  return bps;
}

export function subunitsFromMajor(amount: unknown, currency: string): number {
  if (String(currency || '').toUpperCase() !== 'INR') throw new Error('V93 commission engine currently supports INR only.');
  const n = finiteNumber(amount);
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000_000) throw new Error('Invalid monetary amount.');
  const subunits = n * 100;
  if (!Number.isSafeInteger(subunits)) throw new Error('Monetary amount exceeds supported precision.');
  return subunits;
}

export function majorFromSubunits(subunits: number): number {
  if (!Number.isSafeInteger(subunits)) throw new Error('Invalid currency subunits.');
  return subunits / 100;
}

function roundHalfUp(numerator: number, denominator: number) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('Invalid exact arithmetic input.');
  return Number((BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator));
}

function roundRatioProduct(numeratorA: number, numeratorB: number, denominator: number) {
  if (![numeratorA, numeratorB, denominator].every(Number.isSafeInteger) || denominator <= 0) throw new Error('Invalid exact arithmetic input.');
  return Number((BigInt(numeratorA) * BigInt(numeratorB) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator));
}

export function calculateCommission(grossAmount: number, currency: string, rule: CommissionRule | CommissionRuleInput) {
  const grossSubunits = subunitsFromMajor(grossAmount, currency);
  const percentageBps = Number.isSafeInteger((rule as any).percentageBps) ? Number((rule as any).percentageBps) : normalizePercentageBps((rule as any).percentage ?? 0);
  const fixedAmountSubunits = subunitsFromMajor((rule as any).fixedAmount ?? 0, currency);
  let commissionSubunits = roundRatioProduct(grossSubunits, percentageBps, 10000) + fixedAmountSubunits;
  const minimum = (rule as any).minimumAmount !== undefined && (rule as any).minimumAmount !== null ? subunitsFromMajor((rule as any).minimumAmount, currency) : undefined;
  const maximum = (rule as any).maximumAmount !== undefined && (rule as any).maximumAmount !== null ? subunitsFromMajor((rule as any).maximumAmount, currency) : undefined;
  if (minimum !== undefined) commissionSubunits = Math.max(commissionSubunits, minimum);
  if (maximum !== undefined) commissionSubunits = Math.min(commissionSubunits, maximum);
  if (commissionSubunits < 0 || commissionSubunits > grossSubunits) throw new Error('Commission exceeds gross sale or is otherwise invalid.');
  const creatorNetSubunits = grossSubunits - commissionSubunits;
  if (creatorNetSubunits < 0) throw new Error('Creator net cannot be negative.');
  return {
    grossAmount,
    grossAmountSubunits: grossSubunits,
    platformCommissionAmount: majorFromSubunits(commissionSubunits),
    platformCommissionAmountSubunits: commissionSubunits,
    creatorNetAmount: majorFromSubunits(creatorNetSubunits),
    creatorNetAmountSubunits: creatorNetSubunits,
    currency: String(currency).toUpperCase(),
  };
}

export function calculateProportionalReversal(refundAmountSubunits: number, originalGrossSubunits: number, originalCommissionSubunits: number) {
  if (!Number.isSafeInteger(refundAmountSubunits) || refundAmountSubunits < 0) throw new Error('Invalid refund amount.');
  if (!Number.isSafeInteger(originalGrossSubunits) || originalGrossSubunits <= 0) throw new Error('Invalid original gross amount.');
  if (!Number.isSafeInteger(originalCommissionSubunits) || originalCommissionSubunits < 0 || originalCommissionSubunits > originalGrossSubunits) throw new Error('Invalid original commission amount.');
  if (refundAmountSubunits > originalGrossSubunits) throw new Error('Refund exceeds original gross amount.');
  const commissionReversal = Math.min(originalCommissionSubunits, roundRatioProduct(refundAmountSubunits, originalCommissionSubunits, originalGrossSubunits));
  const creatorReversal = refundAmountSubunits - commissionReversal;
  return { commissionReversalSubunits: commissionReversal, creatorReversalSubunits: creatorReversal };
}

export function validateCommissionRuleInput(input: CommissionRuleInput) {
  if (!['global', 'creator', 'product'].includes(input.scope)) throw new Error('Invalid commission rule scope.');
  if (input.scope === 'creator' && !String(input.creatorId || '').trim()) throw new Error('Creator ID is required for a creator commission rule.');
  if (input.scope === 'product' && !String(input.productId || '').trim()) throw new Error('Product ID is required for a product commission rule.');
  const hasPercentage = input.percentage !== undefined && input.percentage !== null && String(input.percentage).trim() !== '';
  const hasFixed = input.fixedAmount !== undefined && input.fixedAmount !== null && String(input.fixedAmount).trim() !== '';
  if (!hasPercentage && !hasFixed) throw new Error('Configure a percentage and/or fixed commission amount.');
  const percentageBps = normalizePercentageBps(hasPercentage ? input.percentage : 0);
  const fixedAmount = finiteNumber(hasFixed ? input.fixedAmount : 0);
  const minimumAmount = input.minimumAmount !== undefined && input.minimumAmount !== null && String(input.minimumAmount).trim() !== '' ? finiteNumber(input.minimumAmount) : undefined;
  const maximumAmount = input.maximumAmount !== undefined && input.maximumAmount !== null && String(input.maximumAmount).trim() !== '' ? finiteNumber(input.maximumAmount) : undefined;
  for (const [label, value] of [['fixed commission', fixedAmount], ['minimum commission', minimumAmount], ['maximum commission', maximumAmount]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 10_000_000_000)) throw new Error(`Invalid ${label} amount.`);
    if (value !== undefined && !Number.isInteger(value)) throw new Error(`${label} must be specified in whole INR units.`);
  }
  if (minimumAmount !== undefined && maximumAmount !== undefined && minimumAmount > maximumAmount) throw new Error('Minimum commission cannot exceed maximum commission.');
  const currency = String(input.currency || 'INR').toUpperCase();
  if (currency !== 'INR') throw new Error('V93 marketplace commission currently supports INR only.');
  const effectiveFrom = String(input.effectiveFrom || new Date().toISOString());
  if (!Number.isFinite(Date.parse(effectiveFrom))) throw new Error('Invalid effectiveFrom timestamp.');
  const effectiveUntil = input.effectiveUntil ? String(input.effectiveUntil) : undefined;
  if (effectiveUntil && (!Number.isFinite(Date.parse(effectiveUntil)) || Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))) throw new Error('effectiveUntil must be later than effectiveFrom.');
  const priority = Math.max(0, Math.min(1_000_000, Math.trunc(Number(input.priority ?? 0))));
  return {
    percentageBps,
    percentage: percentageBps / 100,
    fixedAmount,
    minimumAmount,
    maximumAmount,
    currency,
    effectiveFrom,
    effectiveUntil,
    priority,
    active: input.active !== false,
    refundPolicy: { proportional: input.refundPolicy?.proportional !== false },
  };
}
