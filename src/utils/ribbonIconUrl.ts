const WEB_RESOURCE_PREFIX = "$webresource:";

/**
 * Validate individual path components before encoding them. Decoding exactly
 * once rejects both direct traversal (%2e%2e) and double-encoded escapes
 * (%252e%252e), while retaining legitimate CRM resource subdirectories.
 */
function safePathSegments(path: string): string[] | null {
	if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\")) return null;
	const result: string[] = [];
	for (const segment of path.split("/")) {
		if (!segment) return null;
		try {
			const decoded = decodeURIComponent(segment);
			if (!decoded.trim() || decoded === "." || decoded === ".." ||
				/[\\/?:#%]|\p{Cc}/u.test(decoded)) return null;
			// RFC 3986 encoding also covers punctuation left bare by encodeURIComponent.
			result.push(encodeURIComponent(decoded).replace(/[!'()*]/g, (character) =>
				`%${character.charCodeAt(0).toString(16).toUpperCase()}`));
		} catch {
			return null;
		}
	}
	return result;
}

/**
 * Resolve a classic RibbonDiffXml $webresource: token only against the active
 * CRM organization. This never follows absolute, script, or escaping paths.
 * A null result tells FluentIcon to retain its original local-icon fallback.
 */
export function resolveRibbonIconUrl(iconName: string, organizationUrl: string): string | null {
	if (typeof iconName !== "string" || !iconName.startsWith(WEB_RESOURCE_PREFIX) ||
		typeof organizationUrl !== "string" || !organizationUrl) return null;

	const resource = safePathSegments(iconName.slice(WEB_RESOURCE_PREFIX.length));
	if (!resource) return null;
	// Inspect the original URL path, before URL() normalizes dot segments.
	const source = /^(?:https?):\/\/[^/?#]+(\/[^?#]*)?$/i.exec(organizationUrl);
	if (!source || organizationUrl.includes("\\")) return null;

	try {
		const organization = new URL(organizationUrl);
		if (!["https:", "http:"].includes(organization.protocol) || !organization.hostname ||
			organization.username || organization.password || organization.search || organization.hash) return null;

		const rawOrgPath = source[1] ?? "";
		if (rawOrgPath.startsWith("//")) return null;
		const trimmed = rawOrgPath.replace(/^\//, "").replace(/\/+$/, "");
		const orgSegments = trimmed ? safePathSegments(trimmed) : [];
		if (!orgSegments) return null;

		return `${organization.origin}/${[...orgSegments, "WebResources", ...resource].join("/")}`;
	} catch {
		return null;
	}
}
