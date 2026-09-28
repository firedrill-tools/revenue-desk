// Input shapes of the QuickBooks tools, shared by the tools and the classifier.
// Money is integer minor units, as everywhere in Revenue Desk; the tools
// convert to QuickBooks' decimal amounts at the request boundary.

import { z } from "zod";
import { identifier, isoDate } from "../shared/schema.js";

/** QuickBooks entity ids are numeric strings. */
export const QBO_ID = /^\d+$/;

const entityId = (noun: string) => identifier(QBO_ID, `The QuickBooks ${noun} id (digits).`);
const rowLimit = (max: number, fallback: number, noun: string) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`At most this many ${noun} (1-${max}, default ${fallback}). Pages are read for you.`);

const invoiceLine = z.object({
  description: z.string().max(4000).optional().describe("Line description shown on the invoice."),
  quantity: z
    .number()
    .positive()
    .max(1_000_000)
    .default(1)
    .describe("Quantity (default 1); decimals allowed, e.g. 1.5 hours."),
  unit_price_minor: z
    .number()
    .int()
    .min(0)
    .describe("Unit price in minor units (12000 is $120.00)."),
  item_id: identifier(
    QBO_ID,
    "The QuickBooks product or service item id; omit to use the company's default item.",
  ).optional(),
});

export const QUICKBOOKS_INPUTS = {
  get_company_info: {},
  find_customers: {
    name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Text contained in the customer's display name."),
    company: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Text contained in the customer's company name."),
    email: z.email().optional().describe("The customer's primary email address, exactly."),
    include_inactive: z
      .boolean()
      .default(false)
      .describe("Also return inactive (deleted) customers."),
    limit: rowLimit(200, 20, "customers"),
  },
  get_customer: {
    customer_id: entityId("customer"),
  },
  list_invoices: {
    customer_id: entityId("customer").optional().describe("Only invoices of this customer."),
    status: z
      .enum(["open", "paid", "all"])
      .default("open")
      .describe("open: balance above zero (default); paid: balance zero; all: both."),
    due_before: isoDate("Only invoices due before this date (YYYY-MM-DD).").optional(),
    due_on_or_after: isoDate("Only invoices due on or after this date (YYYY-MM-DD).").optional(),
    issued_from: isoDate("Only invoices dated on or after this date (YYYY-MM-DD).").optional(),
    issued_to: isoDate("Only invoices dated on or before this date (YYYY-MM-DD).").optional(),
    doc_number: z.string().min(1).max(21).optional().describe("The invoice number, exactly."),
    as_of: isoDate(
      "The business date (YYYY-MM-DD). When given, each unpaid invoice past its due date " +
        "gets days_overdue.",
    ).optional(),
    limit: rowLimit(1000, 200, "invoices"),
  },
  get_invoice: {
    invoice_id: entityId("invoice"),
  },
  list_payments: {
    customer_id: entityId("customer").optional().describe("Only payments of this customer."),
    received_from: isoDate("Only payments dated on or after this date (YYYY-MM-DD).").optional(),
    received_to: isoDate("Only payments dated on or before this date (YYYY-MM-DD).").optional(),
    limit: rowLimit(1000, 100, "payments"),
  },
  create_customer: {
    display_name: z
      .string()
      .min(1)
      .max(500)
      .describe("Unique display name, usually the company name."),
    company_name: z.string().max(100).optional().describe("Company name."),
    given_name: z.string().max(100).optional().describe("Contact's first name."),
    family_name: z.string().max(100).optional().describe("Contact's last name."),
    email: z.email().optional().describe("Billing email address; invoices are sent here."),
    phone: z.string().max(30).optional().describe("Phone number."),
    billing_address: z
      .object({
        line1: z.string().max(500).describe("Street address."),
        city: z.string().max(255).optional(),
        region: z.string().max(255).optional().describe("State, province or region code."),
        postal_code: z.string().max(30).optional(),
        country: z.string().max(255).optional(),
      })
      .optional()
      .describe("Billing address."),
    notes: z.string().max(2000).optional().describe("Internal notes about the customer."),
  },
  create_invoice: {
    customer_id: entityId("customer").describe("The customer to bill (digits)."),
    lines: z
      .array(invoiceLine)
      .min(1)
      .max(50)
      .describe("Invoice lines. The total is the sum of quantity x unit price."),
    due_date: isoDate("Due date (YYYY-MM-DD); defaults to the customer's terms.").optional(),
    invoice_date: isoDate("Invoice date (YYYY-MM-DD); defaults to today.").optional(),
    doc_number: z.string().min(1).max(21).optional().describe("Invoice number, if not automatic."),
    bill_email: z.email().optional().describe("Email address the invoice will be sent to."),
    customer_memo: z
      .string()
      .max(1000)
      .optional()
      .describe("Message to the customer, printed on the invoice."),
    private_note: z
      .string()
      .max(4000)
      .optional()
      .describe("Internal note, not shown to the customer."),
  },
  send_invoice: {
    invoice_id: entityId("invoice"),
    send_to: z
      .email()
      .optional()
      .describe("Send to this address instead of the invoice's billing email."),
  },
  record_payment: {
    customer_id: entityId("customer").describe("The paying customer (digits)."),
    amount_minor: z
      .number()
      .int()
      .min(1)
      .describe("Amount received in minor units (4900 is $49.00)."),
    invoice_id: entityId("invoice")
      .optional()
      .describe("Apply the whole amount to this invoice; omit to record an unapplied payment."),
    payment_date: isoDate("Date received (YYYY-MM-DD); defaults to today.").optional(),
    reference: z
      .string()
      .max(21)
      .optional()
      .describe("Payment reference, e.g. the Stripe charge id or a check number (max 21)."),
    memo: z.string().max(4000).optional().describe("Internal note on the payment."),
  },
  void_invoice: {
    invoice_id: entityId("invoice"),
    sync_token: z
      .string()
      .regex(/^\d+$/)
      .describe("The invoice's current sync_token, from get_invoice."),
  },
} as const;

export const createInvoiceInput = z.object(QUICKBOOKS_INPUTS.create_invoice);
export const createCustomerInput = z.object(QUICKBOOKS_INPUTS.create_customer);
export const sendInvoiceInput = z.object(QUICKBOOKS_INPUTS.send_invoice);
export const recordPaymentInput = z.object(QUICKBOOKS_INPUTS.record_payment);
export const voidInvoiceInput = z.object(QUICKBOOKS_INPUTS.void_invoice);

export type InvoiceLineInput = z.infer<typeof invoiceLine>;

/** A line's total in minor units, rounded to the currency's precision. */
export function lineAmountMinor(
  line: Pick<InvoiceLineInput, "quantity" | "unit_price_minor">,
): number {
  return Math.round(line.quantity * line.unit_price_minor);
}

export function invoiceTotalMinor(lines: readonly InvoiceLineInput[]): number {
  return lines.reduce((total, line) => total + lineAmountMinor(line), 0);
}
