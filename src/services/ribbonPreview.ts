import { canonicalizeXml, mergeRibbonDiffXml } from "@/services/ribbonMerge";
import { generateRibbonDelta } from "@/services/xmlGenerator";
import type { RibbonLocation } from "@/types/ribbon";
import type { RibbonDelta, RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

export type RibbonPreviewScope = "entity" | "application";

export interface RibbonPreviewInput {
	current: RibbonWorkspace;
	baseline: RibbonWorkspace;
	sourceSnapshot: RibbonSourceSnapshot | null;
}

export interface RibbonPreview {
	scope: RibbonPreviewScope;
	/** Exact unmanaged RibbonDiffXml exported from the selected solution. */
	originalXml: string;
	/** Complete intended unmanaged RibbonDiffXml after applying all scope deltas. */
	mergedXml: string;
	deltas: RibbonDelta[];
	changed: boolean;
}

const ENTITY_LOCATIONS = ["HomepageGrid", "SubGrid", "Form"] as const;

/**
 * Pure local preview of the same generate+merge process used for publication.
 * The merged entity source is shared by all three entity locations; emitting
 * individual generated fragments as standalone imports would lose prior edits.
 */
export function buildRibbonPreview(input: RibbonPreviewInput, scope: RibbonPreviewScope): RibbonPreview {
	const source = input.sourceSnapshot;
	if (!source) {
		throw new Error("An exported unmanaged solution source is required for a complete ribbon preview.");
	}
	if (!source.entityLogicalName || ENTITY_LOCATIONS.some((location) =>
		input.current.ribbons[location]?.entityLogicalName !== source.entityLogicalName ||
		input.baseline.ribbons[location]?.entityLogicalName !== source.entityLogicalName
	)) {
		throw new Error("The exported ribbon source does not match the selected entity workspace.");
	}

	// A successfully exported solution with no application layer has a known
	// empty baseline; it is not an export failure.
	const originalXml = scope === "entity" ? source.entityRibbonXml : source.applicationRibbonXml ?? '<RibbonDiffXml/>';
	if (!originalXml) {
		throw new Error(`${scope === "entity" ? "Entity" : "Application"} unmanaged ribbon source is unavailable. Export the selected solution before previewing.`);
	}
	const locations: readonly RibbonLocation[] = scope === "entity" ? ENTITY_LOCATIONS : ["Application"];
	const deltas = locations.map((location) => generateRibbonDelta({
		location,
		entityLogicalName: location === "Application" ? "{!EntityLogicalName}" : source.entityLogicalName,
		current: input.current.ribbons[location],
		baseline: input.baseline.ribbons[location],
		commands: input.current.commands,
		displayRules: input.current.displayRules,
		enableRules: input.current.enableRules,
		locLabels: input.current.locLabels,
		baselineDefinitions: input.baseline,
	}));
	canonicalizeXml(originalXml); // reject malformed source even for an unchanged preview
	const hasChanges = deltas.some((delta) => {
		if (Object.entries(delta).some(([key, value]) => key !== 'xml' && Array.isArray(value) && value.length > 0)) return true;
		const doc = new DOMParser().parseFromString(delta.xml, 'application/xml');
		return !!doc.querySelector('CustomAction, HideCustomAction, CommandDefinition, RuleDefinitions > EnableRules > EnableRule, RuleDefinitions > DisplayRules > DisplayRule, TabDisplayRule, LocLabel, Scaling');
	});
	const mergedXml = hasChanges ? mergeRibbonDiffXml(originalXml, deltas) : originalXml;
	return {
		scope,
		originalXml,
		mergedXml,
		deltas,
		changed: canonicalizeXml(originalXml) !== canonicalizeXml(mergedXml),
	};
}
