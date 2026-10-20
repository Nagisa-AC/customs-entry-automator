/**
 * Synthetic invoice definitions. Every company, SKU and HTS code here is made
 * up; HTS values are format-plausible placeholders, not classifications.
 */
export type NumberFormat = "dot" | "comma";

export interface LineSpec {
  sku: string;
  description: string;
  /** Canonical decimals ("1200", "3.75"); printed per the invoice's format. */
  qty: string;
  uom: string;
  unitPrice: string;
  origin: string | null;
  hts10: string;
  /** Present in the importer's SKU sheet (default true). */
  inCatalog?: boolean;
  /** Print this extended price instead of qty × price (planted error). */
  amountOverride?: string;
}

export interface ExpectedFailure {
  ruleId: string;
  row: number | null;
}

export interface InvoiceSpec {
  name: string;
  purpose: string;
  format: NumberFormat;
  currency: string;
  invoiceNumber: string;
  invoiceDate: string;
  seller: string;
  buyer: string;
  /** Rows drawn on each page, counting a split row on both pages it touches. */
  rowsPerPage: number[];
  /** 0-based indexes of lines whose row is split across the following page break. */
  splitRows?: number[];
  lines: LineSpec[];
  expectedFailures: ExpectedFailure[];
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const HARDWARE = [
  ["Zinc-plated hex bolt M8x40", "7318158060"],
  ["Stainless flat washer M8", "7318220000"],
  ["Nylon insert lock nut M8", "7318160085"],
  ["Steel L-bracket 75mm with countersunk mounting holes", "7326908688"],
  ["Brass cabinet hinge 50mm", "8302104000"],
  ["Drawer slide full extension 450mm", "8302420000"],
  ["Cordless drill battery pack 18V 2.0Ah lithium-ion", "8507600020"],
  ["Rubber grommet assortment kit", "4016995500"],
  ["Aluminium T-slot extrusion 1m", "7604291090"],
  ["PVC conduit elbow 20mm", "3917400080"],
  ["Copper cable lug 16mm2", "8536904000"],
  ["Carbide drill bit 6mm", "8207505000"],
] as const;

const ORIGINS = ["CN", "VN", "TW", "MX", "IN"] as const;

function hardwareLines(count: number, seed: number, skuPrefix: string): LineSpec[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => {
    const [description, hts10] = HARDWARE[i % HARDWARE.length]!;
    const qty = String((1 + Math.floor(rand() * 40)) * 25);
    const cents = 5 + Math.floor(rand() * 2400);
    const unitPrice = (cents / 100).toFixed(2);
    return {
      sku: `${skuPrefix}-${String(1000 + i * 7)}`,
      description,
      qty,
      uom: "PCS",
      unitPrice,
      origin: ORIGINS[Math.floor(rand() * ORIGINS.length)]!,
      hts10,
    };
  });
}

const cleanUs: InvoiceSpec = {
  name: "clean-us-single-page",
  purpose: "Clean one-page US-format invoice; every check passes.",
  format: "dot",
  currency: "USD",
  invoiceNumber: "HL-2026-0412",
  invoiceDate: "2026-09-14",
  seller: "Harbor Lane Hardware Mfg. Co., Ltd. (synthetic)",
  buyer: "Example Importer LLC (synthetic)",
  rowsPerPage: [8],
  lines: [
    ...hardwareLines(7, 11, "HL"),
    { sku: "HL-9001", description: "Precision bearing 608ZZ", qty: "1200", uom: "PCS", unitPrice: "0.335", origin: "CN", hts10: "8482105044" },
  ],
  expectedFailures: [],
};

const multiPage: InvoiceSpec = {
  name: "multipage-split-rows",
  purpose: "Three-page US-format invoice with rows split across both page breaks.",
  format: "dot",
  currency: "USD",
  invoiceNumber: "PX-77310",
  invoiceDate: "2026-09-30",
  seller: "Pacific Crossing Industrial Supply (synthetic)",
  buyer: "Example Importer LLC (synthetic)",
  rowsPerPage: [16, 18, 8],
  splitRows: [15, 32],
  lines: hardwareLines(40, 42, "PX"),
  expectedFailures: [],
};

const european: InvoiceSpec = {
  name: "european-format",
  purpose: "Two-page EUR invoice printed with comma decimals and dot grouping.",
  format: "comma",
  currency: "EUR",
  invoiceNumber: "RE-2026/0098",
  invoiceDate: "28.09.2026",
  seller: "Rheinwerk Beschlaege GmbH (synthetic)",
  buyer: "Example Importer LLC (synthetic)",
  rowsPerPage: [10, 8],
  lines: hardwareLines(18, 7, "RW").map((l, i) => (i % 4 === 0 ? { ...l, qty: String(Number(l.qty) * 12) } : l)),
  expectedFailures: [],
};

const broken: InvoiceSpec = {
  name: "broken-math-unmatched",
  purpose: "One-page invoice with a line-math error, an exact duplicate row, an uncatalogued SKU and a missing origin.",
  format: "dot",
  currency: "USD",
  invoiceNumber: "BK-1003",
  invoiceDate: "2026-10-02",
  seller: "Brightline Fasteners Ltd. (synthetic)",
  buyer: "Example Importer LLC (synthetic)",
  rowsPerPage: [6],
  lines: (() => {
    const base = hardwareLines(5, 99, "BK");
    base[2] = { ...base[2]!, amountOverride: "1.00" };
    base[3] = { ...base[3]!, inCatalog: false, origin: null };
    return [...base, { ...base[1]! }];
  })(),
  expectedFailures: [
    { ruleId: "line-math", row: 3 },
    { ruleId: "required-fields", row: 4 },
    { ruleId: "duplicate-lines", row: 6 },
  ],
};

export const INVOICE_SPECS: readonly InvoiceSpec[] = [cleanUs, multiPage, european, broken];
