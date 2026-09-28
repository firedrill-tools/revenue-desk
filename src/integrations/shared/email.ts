// Email addresses in tool inputs: parsing "Name <a@b.test>" forms and deciding
// whether an address is inside the workspace's internal domains.

const ADDRESS =
  /^[^\s@<>()[\],;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The bare, lower-case address of "ana@acme.test" or "Ana Diaz <ana@acme.test>";
 * null when the text holds no single valid address.
 */
export function parseAddress(text: string): string | null {
  const trimmed = text.trim();
  const angle = /^(?:[^<>]*)<([^<>]+)>$/.exec(trimmed);
  const candidate = (angle?.[1] ?? trimmed).trim().toLowerCase();
  return ADDRESS.test(candidate) ? candidate : null;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Normalises configured domains: lower case, no leading "@" or ".", no blanks. */
export function normaliseDomains(domains: readonly string[]): readonly string[] {
  return domains
    .map((domain) =>
      domain
        .trim()
        .toLowerCase()
        .replace(/^[@.]+/, ""),
    )
    .filter((domain) => domain !== "");
}

/** True when the address's domain is an internal domain or one of its subdomains. */
export function isInternalAddress(address: string, internalDomains: readonly string[]): boolean {
  const domain = domainOf(address);
  return normaliseDomains(internalDomains).some(
    (internal) => domain === internal || domain.endsWith(`.${internal}`),
  );
}
