export enum ChangeSource {
  Polling = 'POLLING',
  Webhook = 'WEBHOOK',
  Excel = 'EXCEL',
}

export interface CanonicalProductPayload {
  sku: string;
  name: string;
  price: string;
  quantity: number;
}

export interface ProductChangeInput {
  productId: string;
  version: number;
  source: ChangeSource;
  payload: CanonicalProductPayload;
  observedAt: Date;
}
