import crypto from 'node:crypto';
import type { RazorpayConfig } from './payment-provider.js';

export type RouteBusinessType =
  | 'individual'
  | 'proprietorship'
  | 'partnership'
  | 'llp'
  | 'private_limited'
  | 'public_limited'
  | 'trust'
  | 'society'
  | 'ngo';

export interface LinkedAccountInput {
  email: string;
  phone: string;
  legalBusinessName: string;
  customerFacingBusinessName: string;
  businessType: RouteBusinessType;
  referenceId: string;
  contactName: string;
  category: string;
  subcategory: string;
  description: string;
  registeredAddress: {
    street1: string;
    street2?: string;
    city: string;
    state: string;
    postalCode: string;
    country?: string;
  };
  website?: string;
}

function config(): RazorpayConfig {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  const environment = String(process.env.RAZORPAY_ENVIRONMENT || 'test').trim().toLowerCase() === 'production' ? 'production' : 'test';
  if (!keyId || !keySecret || !environment) throw new Error('Razorpay configuration is not ready.');
  return { keyId, keySecret, webhookSecret, environment };
}

function authHeader() {
  const c = config();
  return `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}`;
}

function cleanText(value: unknown, max: number) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizePhone(value: unknown) {
  return String(value ?? '').replace(/[^\d+]/g, '').slice(0, 15);
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', authHeader());
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`https://api.razorpay.com/v2${path}`, { ...init, headers });
  const raw = await response.text();
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) {
    const message = String(body?.error?.description || body?.message || `Razorpay Route API failed (${response.status}).`);
    const error: any = new Error(message);
    error.statusCode = response.status === 401 || response.status === 403 ? 502 : (response.status >= 500 ? 503 : 400);
    throw error;
  }
  return body;
}

export async function createLinkedAccount(input: LinkedAccountInput) {
  const website = cleanText(input.website || 'https://offscrpt.vercel.app', 255);
  const phone = normalizePhone(input.phone);
  const payload = {
    email: cleanText(input.email, 64),
    phone,
    legal_business_name: cleanText(input.legalBusinessName, 200),
    customer_facing_business_name: cleanText(input.customerFacingBusinessName || input.legalBusinessName, 255),
    business_type: input.businessType,
    reference_id: cleanText(input.referenceId, 20),
    profile: {
      category: cleanText(input.category, 100),
      subcategory: cleanText(input.subcategory, 100),
      description: cleanText(input.description, 255),
      addresses: {
        registered: {
          street1: cleanText(input.registeredAddress.street1, 255),
          street2: cleanText(input.registeredAddress.street2 || '', 255),
          city: cleanText(input.registeredAddress.city, 100),
          state: cleanText(input.registeredAddress.state, 100),
          postal_code: cleanText(input.registeredAddress.postalCode, 20),
          country: cleanText(input.registeredAddress.country || 'IN', 2).toUpperCase()
        },
        operation: {
          street1: cleanText(input.registeredAddress.street1, 255),
          street2: cleanText(input.registeredAddress.street2 || '', 255),
          city: cleanText(input.registeredAddress.city, 100),
          state: cleanText(input.registeredAddress.state, 100),
          postal_code: cleanText(input.registeredAddress.postalCode, 20),
          country: cleanText(input.registeredAddress.country || 'IN', 2).toUpperCase()
        }
      }
    },
    contact_name: cleanText(input.contactName, 255),
    contact_info: {
      support: { email: cleanText(input.email, 64), phone, policy_url: website },
      refund: { email: cleanText(input.email, 64), phone, policy_url: website },
      chargeback: { email: cleanText(input.email, 64), phone, policy_url: website }
    },
    apps: { websites: [website], android: [], ios: [] },
    notes: { offscrpt_seller_reference: cleanText(input.referenceId, 20) }
  };
  return request('/accounts', { method: 'POST', body: JSON.stringify(payload) });
}

export async function fetchLinkedAccount(accountId: string) {
  const id = cleanText(accountId, 32);
  if (!/^acc_[A-Za-z0-9]+$/.test(id)) throw new Error('Invalid Razorpay Linked Account ID.');
  return request(`/accounts/${encodeURIComponent(id)}`, { method: 'GET' });
}

export async function updateLinkedAccount(accountId: string, patch: Record<string, unknown>) {
  const id = cleanText(accountId, 32);
  if (!/^acc_[A-Za-z0-9]+$/.test(id)) throw new Error('Invalid Razorpay Linked Account ID.');
  return request(`/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function providerHealth(accountId: string, providerStatus?: string) {
  if (!accountId) return 'not_started';
  if (providerStatus === 'suspended') return 'suspended';
  if (providerStatus === 'created') return 'pending';
  return 'ready';
}

export function verifyRouteWebhook(rawBody: string, signature: string) {
  const secret = config().webhookSecret;
  if (!secret || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
