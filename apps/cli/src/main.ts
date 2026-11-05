import { EXTRACTION_SCHEMA_VERSION } from "@cea/core";

export function run(argv: string[]): number {
  const [command] = argv;
  if (command === "version" || command === "--version") {
    console.log(`cea (schema ${EXTRACTION_SCHEMA_VERSION})`);
    return 0;
  }
  console.error("usage: cea version");
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
