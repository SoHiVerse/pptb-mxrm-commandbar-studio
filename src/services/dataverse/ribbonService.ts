import { decompressRibbonZip } from "@/utils/decompressRibbonZip";
import { parseRibbonXml } from "@/services/xmlParser";
import type { RibbonDefinition, RibbonLocation, RibbonTab } from "@/types/ribbon";
import { useRuntimeLogStore } from "@/store/runtimeLogStore";

const dataverseAPI = (window as Window & typeof globalThis).dataverseAPI!;

type EntityRibbonLocation = Exclude<RibbonLocation, "Application">;

export interface RibbonWorkspaceData {
	ribbons: Record<RibbonLocation, ReturnType<typeof parseRibbonXml>["ribbon"]>;
	commands: ReturnType<typeof parseRibbonXml>["commands"];
	displayRules: ReturnType<typeof parseRibbonXml>["displayRules"];
	enableRules: ReturnType<typeof parseRibbonXml>["enableRules"];
	locLabels: ReturnType<typeof parseRibbonXml>["locLabels"];
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
	const seen = new Set<string>();
	const deduped: T[] = [];
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		deduped.push(item);
	}
	return deduped;
}

/**
 * Splits an already-merged entity ribbon into the three EntityRibbonLocation
 * buckets based on the Microsoft tab-ID naming convention documented at
 * https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/ribbons-available:
 *   - Mscrm.Form.<entity>.*        → Form
 *   - Mscrm.HomepageGrid.<entity>.* → HomepageGrid
 *   - Mscrm.SubGrid.<entity>.*     → SubGrid
 *
 * Tabs without a recognized prefix default to HomepageGrid (most common
 * fallback for custom tabs). This may need to be refined once we observe
 * real customer ribbon shapes in PPTB. Live CRM loading does not use this
 * helper: valid publisher-prefixed Form/SubGrid tabs cannot be classified by
 * their IDs, so the server's location filter is authoritative instead.
 */
export function splitTabsByLocation(
	ribbon: RibbonDefinition,
	entityLogicalName: string,
): Record<EntityRibbonLocation, RibbonDefinition> {
	const buckets: Record<EntityRibbonLocation, RibbonTab[]> = {
		HomepageGrid: [],
		SubGrid: [],
		Form: [],
	};

	for (const tab of ribbon.tabs) {
		if (tab.id.startsWith("Mscrm.Form.")) {
			buckets.Form.push(tab);
		} else if (tab.id.startsWith("Mscrm.SubGrid.")) {
			buckets.SubGrid.push(tab);
		} else if (tab.id.startsWith("Mscrm.HomepageGrid.")) {
			buckets.HomepageGrid.push(tab);
		} else {
			// Custom / unrecognized tab. Default to HomepageGrid; the user can
			// still see and edit it.
			buckets.HomepageGrid.push(tab);
		}
	}

	const result = {} as Record<EntityRibbonLocation, RibbonDefinition>;
	for (const location of ["HomepageGrid", "SubGrid", "Form"] as const) {
		const locationTabs = buckets[location];
		const ownedTabIds = new Set(locationTabs.map((tab) => tab.id));
		const scalings = Object.fromEntries(
			Object.entries(ribbon.scalingByTab ?? {}).filter(([tabId]) => ownedTabIds.has(tabId)),
		);
		result[location] = {
			location,
			entityLogicalName,
			tabs: locationTabs,
			...(Object.keys(scalings).length ? { scalingByTab: scalings } : {}),
		};
	}
	return result;
}

/**
 * Retrieves the three entity ribbon locations individually and uses each
 * server-requested scope as authoritative for its custom/publisher tab IDs.
 *
 * Implementation note — Dataverse Web API enum parameter encoding:
 *
 * `RetrieveEntityRibbon` declares `RibbonLocationFilter` as Nullable: False
 * (https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveentityribbon).
 * Omitting it causes Dataverse's OData function-dispatch to fail with:
 *
 *   0x80060888: Resource not found for the segment 'RetrieveEntityRibbon'.
 *
 * The Web API expects the value as a type-qualified enum literal, e.g.
 *   RibbonLocationFilter=Microsoft.Dynamics.CRM.RibbonLocationFilters'All'
 *
 * PPTB's `formatFunctionParameter()` helper recognizes this pattern via the
 * regex `/^Microsoft\.Dynamics\.CRM\.\w+'.+'$/` and URL-encodes it WITHOUT the
 * Edm.String single-quote wrapping that ordinary strings receive. So we pass
 * the full type-qualified string and PPTB does the right thing.
 *
 * Individual Form, HomepageGrid and SubGrid filters were verified against
 * Dynamics 365 CE on-premises v9.1. The combined 'All' result cannot
 * reliably classify publisher-prefixed controls into their ribbon locations.
 * Reference: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/ribbonlocationfilters
 */
const ENTITY_RIBBON_LOCATIONS = ["HomepageGrid", "SubGrid", "Form"] as const satisfies readonly EntityRibbonLocation[];
const ribbonLocationFilter = (location: EntityRibbonLocation) =>
	`Microsoft.Dynamics.CRM.RibbonLocationFilters'${location}'`;

export async function fetchEntityRibbonAllLocations(entityLogicalName: string): Promise<{
	ribbons: Record<EntityRibbonLocation, RibbonDefinition>;
	commands: ReturnType<typeof parseRibbonXml>["commands"];
	displayRules: ReturnType<typeof parseRibbonXml>["displayRules"];
	enableRules: ReturnType<typeof parseRibbonXml>["enableRules"];
	locLabels: ReturnType<typeof parseRibbonXml>["locLabels"];
}> {
	useRuntimeLogStore.getState().logInfo(
		"dataverse", `RetrieveEntityRibbon(${entityLogicalName}, HomepageGrid/SubGrid/Form)`,
	);
	// Three bounded parallel reads; a failed scoped request must fail the whole
	// workspace load. Falling back to 'All' would silently misclassify tabs.
	const perLocation = await Promise.all(ENTITY_RIBBON_LOCATIONS.map(async (location) => {
		const result = await dataverseAPI.execute({
			operationName: "RetrieveEntityRibbon",
			operationType: "function",
			parameters: {
				EntityName: entityLogicalName,
				RibbonLocationFilter: ribbonLocationFilter(location),
			},
		});
		if (typeof result?.CompressedEntityXml !== "string") {
			throw new Error(`RetrieveEntityRibbon(${entityLogicalName}, ${location}) returned no compressed ribbon XML.`);
		}
		const xml = await decompressRibbonZip(result.CompressedEntityXml);
		return { location, parsed: parseRibbonXml(xml, location, entityLogicalName) };
	}));
	const ribbons = {} as Record<EntityRibbonLocation, RibbonDefinition>;
	for (const { location, parsed } of perLocation) ribbons[location] = parsed.ribbon;

	useRuntimeLogStore
		.getState()
		.logInfo(
			"dataverse",
			`RetrieveEntityRibbon succeeded for ${entityLogicalName} ` +
			`(Form=${ribbons.Form.tabs.length}, ` +
			`HomepageGrid=${ribbons.HomepageGrid.tabs.length}, ` +
			`SubGrid=${ribbons.SubGrid.tabs.length})`,
		);

	return {
		ribbons,
		// Definitions are shared among locations; a declaration may legitimately
		// appear in several filtered results, while identical tab IDs can occur in
		// different scopes and must remain in each ribbon unchanged.
		commands: dedupeById(perLocation.flatMap(({ parsed }) => parsed.commands)),
		displayRules: dedupeById(perLocation.flatMap(({ parsed }) => parsed.displayRules)),
		enableRules: dedupeById(perLocation.flatMap(({ parsed }) => parsed.enableRules)),
		locLabels: dedupeById(perLocation.flatMap(({ parsed }) => parsed.locLabels)),
	};
}

/**
 * Retrieves and parses the application ribbon (cross-entity + global tabs).
 */
export async function fetchApplicationRibbon() {
	useRuntimeLogStore.getState().logInfo("dataverse", "RetrieveApplicationRibbon()");
	const result = await dataverseAPI.execute({
		operationName: "RetrieveApplicationRibbon",
		operationType: "function",
	});

	const xml = await decompressRibbonZip(result.CompressedApplicationRibbonXml as string);
	useRuntimeLogStore.getState().logInfo("dataverse", "RetrieveApplicationRibbon succeeded");
	return parseRibbonXml(xml, "Application", "{!EntityLogicalName}");
}

export async function fetchRibbonWorkspace(
	entityLogicalName: string,
): Promise<RibbonWorkspaceData> {
	const [entity, application] = await Promise.all([
		fetchEntityRibbonAllLocations(entityLogicalName),
		fetchApplicationRibbon(),
	]);

	return {
		ribbons: {
			HomepageGrid: entity.ribbons.HomepageGrid,
			SubGrid: entity.ribbons.SubGrid,
			Form: entity.ribbons.Form,
			Application: application.ribbon,
		},
		commands: dedupeById([...entity.commands, ...application.commands]),
		displayRules: dedupeById([...entity.displayRules, ...application.displayRules]),
		enableRules: dedupeById([...entity.enableRules, ...application.enableRules]),
		locLabels: dedupeById([...entity.locLabels, ...application.locLabels]),
	};
}
