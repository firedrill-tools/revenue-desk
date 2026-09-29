/**
 * The credentials the local fakes accept. They are not secrets: they open
 * nothing but loopback fakes. They are shaped like real ones (sk_test_,
 * pat-) on purpose, so the product's redactor treats them as secrets
 * and tests can prove that no credential reaches logs, the database, SSE or
 * stdout.
 */
export const FAKE_CREDENTIALS = {
  /** A dummy Messages API key for the scripted model (test/support/mock-anthropic.ts). */
  anthropicApiKey: `sk-ant-api03-rdfake-${"a".repeat(32)}`,
  composioApiKey: "ak_rdfake_composio_0000000000000000",
  stripeSecretKey: "sk_test_rdfake51KestrelAnalytics0000000000",
  hubspotAccessToken: "pat-na1-00000000-0000-4000-8000-rdfakehubspot",
  hubspotMcpToken: "rdfake-hubspot-mcp-bearer-0000000000",
} as const;

export type FakeCredentialName = keyof typeof FAKE_CREDENTIALS;

/** Every credential value, for "never appears in output" assertions. */
export const FAKE_CREDENTIAL_VALUES: readonly string[] = Object.values(FAKE_CREDENTIALS);
