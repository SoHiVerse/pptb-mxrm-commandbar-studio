import { fetchRibbonSource } from "./ribbonSourceService";
import { fetchRibbonWorkspace } from "./ribbonService";
import { hydrateRibbonLabels } from "@/services/hydrateRibbonLabels";
import type { RibbonSourceSnapshot } from "@/types/workspace";

/**
 * Capture editable source first. If it changes while the merged model loads,
 * publication's fresh export detects the conflict instead of pairing an old
 * model with a newer source snapshot that would wrongly pass preflight.
 */
export async function fetchSourceBoundWorkspace(solutionUniqueName: string, entityLogicalName: string, organizationUrl: string) {
	let sourceSnapshot: RibbonSourceSnapshot | null = null;
	let sourceError: string | null = null;
	try {
		sourceSnapshot = await fetchRibbonSource(solutionUniqueName, entityLogicalName, organizationUrl);
	} catch (error) {
		sourceError = error instanceof Error ? error.message : String(error);
	}
	const merged = await fetchRibbonWorkspace(entityLogicalName);
	// RetrieveEntityRibbon may omit every LocLabel even though ExportSolution
	// contains the selected unmanaged label definitions. Hydrate the display
	// model here, before the caller captures its initial published baseline.
	const workspace = hydrateRibbonLabels(merged, sourceSnapshot);
	return { workspace, sourceSnapshot, sourceError };
}
