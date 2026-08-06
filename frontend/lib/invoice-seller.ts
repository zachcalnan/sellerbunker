/** Seller details for order PDF invoices (Companies House). */
export const INVOICE_SELLER = {
  legalName: "ZEFA PRODUCT SERVICES LTD",
  companyNumber: "16055169",
  addressLines: [
    "Thorpe View",
    "Wymeswold Road",
    "Nottinghamshire",
    "United Kingdom",
    "NG12 5QU",
  ],
  /** Companies House registered office (single-line). */
  registeredOffice:
    "Thorpe View, Wymeswold Road, Nottinghamshire, United Kingdom, NG12 5QU",
} as const;

export type OrderInvoiceLine = {
  orderId: string;
  orderDate: string;
  sku: string;
  asin: string | null;
  title: string | null;
  quantity: number;
  /** Unit sale price as shown on Orders. Line total = salePrice × quantity. */
  salePrice: number;
  fulfillmentType?: "FBA" | "FBM" | null;
};
