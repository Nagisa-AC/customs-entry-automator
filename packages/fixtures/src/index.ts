import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export * from "./specs.ts";
export { formatNumber, generateInvoice, layoutRows, writeFixtures } from "./generate.ts";

/** Directory holding the committed synthetic invoice fixtures. */
export const INVOICES_DIR = fileURLToPath(new URL("../invoices/", import.meta.url));

export function fixtureDir(name: string): string {
  return `${INVOICES_DIR}${name}`;
}

export function listFixtures(): string[] {
  return readdirSync(INVOICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
