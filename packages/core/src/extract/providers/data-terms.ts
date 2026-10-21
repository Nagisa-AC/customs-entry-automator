import { ProviderError } from "../types.ts";

/**
 * Real model providers receive invoice page images. Until an operator attests
 * that the configured account has zero-retention terms and processes data in
 * a US region, real providers refuse to start. Code cannot verify a contract;
 * this makes the attestation explicit and deliberate.
 */
export function assertProviderDataTerms(provider: string, env: NodeJS.ProcessEnv): void {
  const missing: string[] = [];
  if (env.CEA_PROVIDER_ZERO_RETENTION !== "confirmed") missing.push("CEA_PROVIDER_ZERO_RETENTION=confirmed");
  if (env.CEA_PROVIDER_REGION?.toLowerCase() !== "us") missing.push("CEA_PROVIDER_REGION=us");
  if (missing.length) {
    throw new ProviderError(
      `${provider} is disabled until its account is confirmed for zero data retention and US-region processing (set ${missing.join(" and ")} only after verifying the contract)`,
      false,
    );
  }
}
