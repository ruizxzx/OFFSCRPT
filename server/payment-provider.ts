
export interface PaymentProvider {
  createOrder(input:{amountSubunit:number;currency:string;receipt:string;notes?:Record<string,string>}):Promise<any>;
  fetchPayment(paymentId:string):Promise<any>;
  verifyPaymentSignature(orderId:string,paymentId:string,signature:string):boolean;
  verifyWebhookSignature(rawBody:string,signature:string):boolean;
  fetchOrder(orderId:string):Promise<any>;
}

export type RazorpayEnvironment = 'test'|'production';

export interface RazorpayConfig {
  keyId:string;
  keySecret:string;
  webhookSecret:string;
  environment:RazorpayEnvironment;
}
