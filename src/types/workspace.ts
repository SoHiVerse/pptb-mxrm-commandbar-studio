import type {
	CommandDefinition,
	DisplayRule,
	EnableRule,
	LocLabel,
	RibbonDefinition,
	RibbonLocation,
} from "./ribbon";

/** The editable definitions and their independently captured baseline. */
export interface RibbonDefinitions {
	commands: CommandDefinition[];
	displayRules: DisplayRule[];
	enableRules: EnableRule[];
	locLabels: LocLabel[];
}

export interface RibbonWorkspace extends RibbonDefinitions {
	ribbons: Record<RibbonLocation, RibbonDefinition>;
}

/** Server-exported unmanaged source. Never reconstruct this from merged ribbon data. */
export interface RibbonSourceSnapshot {
	/** Filled by the live source service; pure package parsing does not invent an origin. */
	organizationUrl?: string;
	/** Signed-in CRM identity; used to avoid offering another user's browser draft. */
	userId?: string;
	solutionUniqueName: string;
	entityLogicalName: string;
	solutionVersion: string;
	solutionXml: string;
	customizationsXml: string;
	entityRibbonXml: string;
	applicationRibbonXml: string | null;
	capturedAt: string;
}

/** XML additions/replacements plus edits that cannot be represented by an additive fragment. */
export interface RibbonDelta {
	xml: string;
	/** Narrow edits to uniquely owned unmanaged containers, never whole merged tab/group copies. */
	elementPatches?: Array<{ kind: "Tab" | "Group"; id: string; attributes: Record<string, string | null> }>;
	removedControlIds: string[];
	removedGroupIds: string[];
	removedTabIds: string[];
	unhiddenControlIds: string[];
	removedCommandIds: string[];
	removedEnableRuleIds: string[];
	removedDisplayRuleIds: string[];
	removedLocLabelIds: string[];
	removedTabDisplayRuleCommands: string[];
	removedScalingTabIds: string[];
}

export interface RibbonSolutionChanges {
	entityRibbonXml?: string;
	applicationRibbonXml?: string;
	solutionVersion?: string;
}

export interface RibbonSolutionPackage {
	base64: string;
	backupBase64: string;
	entityRibbonXml?: string;
	applicationRibbonXml?: string;
}

/** Versioned draft retains the source/baseline needed to detect a stale restoration. */
export interface RibbonDraft {
	version: 2;
	current: RibbonWorkspace;
	baseline: RibbonWorkspace;
	sourceSnapshot: RibbonSourceSnapshot;
	savedAt: string;
}
