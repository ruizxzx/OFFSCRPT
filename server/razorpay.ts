
import crypto from 'node:crypto';
import type { PaymentProvider, RazorpayConfig } from './payment-provider.js';

export function getRazorpayConfig():RazorpayConfig{
  const keyId=String(process.env.RAZORPAY_KEY_ID||'');
  const keySecret=String(process.env.RAZORPAY_KEY_SECRET||'');
  const webhookSecret=String(process.env.RAZORPAY_WEBHOOK_SECRET||'');
  const environment=String(process.env.RAZORPAY_ENVIRONMENT||'').toLowerCase()==='production'?'production':'test';
  if(!keyId||!keySecret||!process.env.RAZORPAY_ENVIRONMENT) throw new Error('Razorpay server credentials are not configured.');
  return {keyId,keySecret,webhookSecret,environment};
}
export function isRazorpayConfigured():boolean{
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_ENVIRONMENT);
}
function baseUrl(){return 'https://api.razorpay.com/v1';}
function authHeader(){
  const c=getRazorpayConfig();
  return `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}`;
}
async function request(path:string,init:RequestInit={}){
  const headers=new Headers(init.headers||{});
  headers.set('Authorization',authHeader());
  headers.set('Content-Type','application/json');
  const r=await fetch(`${baseUrl()}${path}`,{...init,headers});
  const text=await r.text(); let body:any={};
  try{body=text?JSON.parse(text):{};}catch{body={raw:text};}
  if(!r.ok){
    const message=String(body?.error?.description||body?.message||`Razorpay API failed: ${r.status}`);
    const err:any=new Error(message); err.statusCode=r.status>=500?503:400; throw err;
  }
  return body;
}
function amountSubunit(amount:number,currency:string){
  if(String(currency||'').toUpperCase()!=='INR') throw new Error('V90 Razorpay checkout currently supports INR only.');
  if(!Number.isSafeInteger(amount)||amount<1||amount>10_000_000_000) throw new Error('Invalid payment amount.');
  // OFFSCRPT Commerce stores money in currency subunits already.
  return amount;
}
function timingSafeHex(expected:string,actual:string){
  if(!expected||!actual||expected.length!==actual.length)return false;
  return crypto.timingSafeEqual(Buffer.from(expected,'utf8'),Buffer.from(actual,'utf8'));
}
export const razorpayProvider:PaymentProvider & {
  amountSubunit(amount:number,currency:string):number;
  config():RazorpayConfig;
  request(path:string,init?:RequestInit):Promise<any>;
} = {
  config:getRazorpayConfig,
  amountSubunit,
  request,
  async createOrder(input){
    return request('/orders',{method:'POST',body:JSON.stringify({
      amount:amountSubunit(input.amountSubunit,input.currency),
      currency:String(input.currency).toUpperCase(),
      receipt:String(input.receipt).slice(0,40),
      notes:input.notes
    })});
  },
  async fetchPayment(paymentId){return request(`/payments/${encodeURIComponent(paymentId)}`);},
  async fetchOrder(orderId){return request(`/orders/${encodeURIComponent(orderId)}`);},
  verifyPaymentSignature(orderId,paymentId,signature){
    const {keySecret}=getRazorpayConfig(); if(!orderId||!paymentId||!signature)return false;
    const expected=crypto.createHmac('sha256',keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    return timingSafeHex(expected,signature);
  },
  verifyWebhookSignature(rawBody,signature){
    const {webhookSecret}=getRazorpayConfig(); if(!webhookSecret||!signature)return false;
    const expected=crypto.createHmac('sha256',webhookSecret).update(rawBody).digest('hex');
    return timingSafeHex(expected,signature);
  }
};
export async function verifyCapturedPayment(order:any,paymentId:string){
  const payment=await razorpayProvider.fetchPayment(paymentId);
  const expected=razorpayProvider.amountSubunit(Number(order.fields.total||0),String(order.fields.currency||'INR'));
  if(String(payment?.order_id||'')!==String(order.fields.razorpayOrderId||order.fields.metadata?.razorpayOrderId||'')) throw new Error('Razorpay payment does not belong to this order.');
  if(Number(payment?.amount)!==expected) throw new Error('Razorpay payment amount mismatch.');
  if(String(payment?.currency||'').toUpperCase()!==String(order.fields.currency||'INR').toUpperCase()) throw new Error('Razorpay payment currency mismatch.');
  if(String(payment?.status||'').toLowerCase()!=='captured') throw new Error(`Payment is not captured (${String(payment?.status||'unknown')}).`);
  return payment;
}
