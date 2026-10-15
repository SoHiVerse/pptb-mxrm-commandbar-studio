import { parseRibbonSolution } from "@/services/ribbonSolutionPackage";
import type { RibbonSourceSnapshot } from "@/types/workspace";

export function normalizedOrganizationUrl(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Invalid Dynamics organization URL.");
	}
	return url.href.replace(/\/+$/, "");
}

/** Check the live host, not only the UI store: PPTB can change its active connection. */
export async function assertActiveOrganization(expectedUrl: string): Promise<void> {
	const connection = await window.toolboxAPI?.connections.getActiveConnection();
	if (!connection?.url || normalizedOrganizationUrl(connection.url) !== normalizedOrganizationUrl(expectedUrl)) {
		throw new Error("The active organization connection changed. Reload the workspace before publishing.");
	}
}

export async function fetchRibbonSource(
	solutionUniqueName: string,
	entityLogicalName: string,
	expectedOrganizationUrl?: string,
): Promise<RibbonSourceSnapshot> {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(solutionUniqueName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entityLogicalName)) {
		throw new Error("A valid solution and entity identity are required to export the ribbon source.");
	}
	const connection = await window.toolboxAPI?.connections.getActiveConnection();
	if (!connection?.url || !window.dataverseAPI) throw new Error("An active Dynamics connection is required.");
	const organizationUrl = normalizedOrganizationUrl(expectedOrganizationUrl ?? connection.url);
	await assertActiveOrganization(organizationUrl);
	const response = await window.dataverseAPI.execute({
		operationName: "ExportSolution", operationType: "action",
		parameters: { SolutionName: solutionUniqueName, Managed: false },
	});
	await assertActiveOrganization(organizationUrl);
	if (typeof response.ExportSolutionFile !== "string" || !response.ExportSolutionFile) {
		throw new Error("ExportSolution returned no solution ZIP. The workspace remains read-only.");
	}
	const who = await window.dataverseAPI.execute({ operationName: "WhoAmI", operationType: "function" });
	if (typeof who.UserId !== "string" || !who.UserId) throw new Error("The signed-in user could not be verified for this ribbon source.");
	await assertActiveOrganization(organizationUrl);
	return { ...parseRibbonSolution(response.ExportSolutionFile, solutionUniqueName, entityLogicalName), organizationUrl, userId: who.UserId.toLowerCase() };
}
