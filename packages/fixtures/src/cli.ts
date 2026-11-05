import { INVOICE_SPECS, INVOICES_DIR, writeFixtures } from "./index.ts";

const written = await writeFixtures(INVOICE_SPECS, INVOICES_DIR);
console.log(`wrote ${written.length} files to ${INVOICES_DIR}`);
