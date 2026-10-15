// ============================================================
// Command Bar Studio — Core ribbon domain types
// Source of truth: copilot-instructions.md §4 Domain Model
// ============================================================

export type RibbonLocation =
	| "HomepageGrid" // Mscrm.HomepageGrid.<entity>
	| "SubGrid" // Mscrm.SubGrid.<entity>
	| "Form" // Mscrm.Form.<entity>
	| "Application"; // applicationRibbon.xml — cross-entity

export type RibbonButtonKind =
	| "button"
	| "flyout"
	| "splitButton"
	| "textBox"
	| "comboBox"
	| "checkBox";

/**
 * Where a ribbon element actually comes from, determined from Dataverse solution
 * layers (msdyn_componentlayer), NOT from id-prefix guessing:
 *  - "oob"        — Microsoft platform base ribbon (no solution layer owns it)
 *  - "managed"    — added/owned by a managed solution (first-party app like
 *                   Field Service / Sales, or an ISV). Override-only.
 *  - "unmanaged"  — your unmanaged customization (the Active layer). Editable.
 *
 * The legacy `oob` / `custom` / `managed` booleans are derived from this (see
 * applyButtonOrigin) so existing UI keeps working.
 */
export type RibbonOrigin = "oob" | "managed" | "unmanaged";

export interface RibbonButton {
	id: string;
	/** Raw merged control XML. Preserves extension attributes and nested menus on an edit. */
	sourceXml?: string;
	label: string;
	tooltipTitle?: string;
	tooltipBody?: string;
	icon?: string;
	image16?: string;
	image32?: string;
	kind: RibbonButtonKind;
	sequence: number;
	templateAlias: string;
	commandId: string;
	hidden: boolean;
	oob: boolean;
	custom: boolean;
	managed: boolean;
	/** Provenance from solution layers; undefined until resolved. */
	origin?: RibbonOrigin;
	/** Owning solution friendly name (for managed/unmanaged buttons). */
	solutionName?: string;
	/** Owning publisher name (for managed buttons — e.g. "Microsoft Dynamics 365"). */
	publisherName?: string;
}

export interface RibbonGroup {
	id: string;
	/** Original group subtree, including elements the visual model cannot represent. */
	sourceXml?: string;
	label: string;
	sequence: number;
	template: string;
	buttons: RibbonButton[];
}

export interface RibbonTab {
	id: string;
	/** Original tab subtree. Do not regenerate unknown children from the visual model. */
	sourceXml?: string;
	label: string;
	sequence: number;
	commandId?: string;
	template?: string;
	tabDisplayRules: TabDisplayRule[];
	groups: RibbonGroup[];
}

export interface RibbonDefinition {
	location: RibbonLocation;
	entityLogicalName: string;
	tabs: RibbonTab[];
	flow?: string[];
	scalingByTab?: Record<string, ScalingDefinition>;
}

export interface CommandDefinition {
	id: string;
	/** Original command XML, including unsupported action/extensions for safe comparisons. */
	sourceXml?: string;
	enableRules: string[];
	displayRules: string[];
	actions: RibbonAction[];
}

export type RibbonAction = JavaScriptAction | UrlAction | PowerFxAction | CustomApiAction;

export interface JavaScriptAction {
	kind: "javascript";
	library: string;
	functionName: string;
	params: ActionParameter[];
}

export interface UrlAction {
	kind: "url";
	address: string;
	passParams: boolean;
	winMode?: 0 | 1 | 2;
	width?: number;
	height?: number;
	params: ActionParameter[];
}

export interface PowerFxAction {
	kind: "powerFx";
	expression: string;
}

export interface CustomApiAction {
	kind: "customApi";
	actionName: string;
	boundParameter?: string;
	inputParameters: { name: string; value: string }[];
	outputParameters: string[];
}

export type ActionParameter =
	| { kind: "CrmParameter"; name?: string; value: CrmParameterValue }
	| { kind: "BoolParameter"; name?: string; value: boolean }
	| { kind: "IntParameter"; name?: string; value: number }
	| { kind: "DecimalParameter"; name?: string; value: number }
	| { kind: "StringParameter"; name?: string; value: string };

export type CrmParameterValue =
	| "PrimaryControl"
	| "PrimaryControlId"
	| "SelectedControl"
	| "CommandProperties"
	| "PrimaryEntityTypeCode"
	| "PrimaryEntityTypeName"
	| "FirstPrimaryItemId"
	| "PrimaryItemIds"
	| "SelectedEntityTypeCode"
	| "SelectedEntityTypeName"
	| "FirstSelectedItemId"
	| "SelectedControlSelectedItemCount"
	| "SelectedControlSelectedItemIds"
	| "SelectedControlSelectedItemReferences"
	| "SelectedControlAllItemCount"
	| "SelectedControlAllItemIds"
	| "SelectedControlAllItemReferences"
	| "SelectedControlUnselectedItemCount"
	| "SelectedControlUnselectedItemIds"
	| "SelectedControlUnselectedItemReferences"
	| "OrgName"
	| "OrgLcid"
	| "UserLcid";

export interface EnableRule {
	id: string;
	sourceXml?: string;
	steps: RuleStep[];
}

export interface DisplayRule {
	id: string;
	sourceXml?: string;
	steps: RuleStep[];
}

// RuleStep covers every rule kind from RibbonCore.xsd + RibbonTypes.xsd.
// Rules marked "(display only)" are NOT valid inside an <EnableRule>.
export type RuleStep =
	| {
			kind: "CommandClientTypeRule";
			// "Modern"  = Dynamics 365 for tablets (NOT Unified Interface web client)
			// "Refresh" = Updated UI / Unified Interface (web)
			// "Legacy"  = Classic ribbon / Outlook list views
			type: "Modern" | "Refresh" | "Legacy";
			default?: boolean;
			invertResult?: boolean;
	  }
	| { kind: "CrmClientTypeRule"; type: "Web" | "Outlook"; invertResult?: boolean }
	| { kind: "CrmOfflineAccessStateRule"; state: "Offline" | "Online"; invertResult?: boolean }
	| {
			kind: "CrmOutlookClientTypeRule";
			type: "CrmForOutlook" | "CrmForOutlookOfflineAccess";
			invertResult?: boolean;
	  }
	| {
			// display only
			kind: "CrmOutlookClientVersionRule";
			major: number;
			minor?: number;
			build?: number;
			revision?: number;
			invertResult?: boolean;
	  }
	| {
			kind: "CustomRule";
			library: string;
			functionName: string;
			default?: boolean;
			invertResult?: boolean;
	  }
	| {
			// display only
			kind: "DeviceTypeRule";
			type: "None" | "Phone" | "Tablet" | "Web" | "Outlook" | "InteractionCentric";
			invertResult?: boolean;
	  }
	| {
			// display only — privilegeDepth REQUIRED
			kind: "EntityPrivilegeRule";
			entityName?: string;
			appliesTo?: "PrimaryEntity" | "SelectedEntity";
			privilegeType:
				| "Create"
				| "Read"
				| "Write"
				| "Delete"
				| "Assign"
				| "Share"
				| "Append"
				| "AppendTo";
			privilegeDepth: "None" | "Basic" | "Local" | "Deep" | "Global";
			invertResult?: boolean;
	  }
	| {
			// display only — propertyValue REQUIRED
			kind: "EntityPropertyRule";
			entityName?: string;
			appliesTo?: "PrimaryEntity" | "SelectedEntity";
			propertyName: EntityProperty;
			propertyValue: boolean;
			invertResult?: boolean;
	  }
	| {
			kind: "EntityRule";
			entityName?: string;
			context?: string;
			appliesTo?: "PrimaryEntity" | "SelectedEntity";
			invertResult?: boolean;
	  }
	| { kind: "FormEntityContextRule"; entityName: string; invertResult?: boolean }
	| {
			kind: "FormStateRule";
			state: "Create" | "Existing" | "ReadOnly" | "Disabled" | "BulkEdit";
			invertResult?: boolean;
	  }
	| {
			kind: "FormTypeRule";
			type:
				| "Main"
				| "Preview"
				| "AppointmentBook"
				| "Dashboard"
				| "Quick"
				| "QuickCreate"
				| "Card"
				| "MainInteractionCentric";
			invertResult?: boolean;
	  }
	| { kind: "HideForTabletExperienceRule"; invertResult?: boolean }
	| {
			kind: "MiscellaneousPrivilegeRule";
			privilegeName: string;
			privilegeDepth?: "None" | "Basic" | "Local" | "Deep" | "Global";
			invertResult?: boolean;
	  }
	| {
			// display only
			kind: "OptionSetRule";
			optionSet: string;
			stateCode: string;
			objectTypeCode: string;
			invertResult?: boolean;
	  }
	| {
			kind: "OrganizationSettingRule";
			setting:
				| "IsSharepointEnabled"
				| "IsSOPIntegrationEnabled"
				| "IsFiscalCalendarDefined"
				| "IsReadFormModeDefined"
				| "IsBPFEntityCustomizationFeatureEnabled";
			invertResult?: boolean;
	  }
	| {
			// Schema requires minimum 2 <Or> children
			kind: "OrRule";
			rules: RuleStep[];
	  }
	| {
			kind: "OutlookItemTrackingRule";
			trackedInCrm: boolean;
			appliesTo?: "PrimaryEntity";
			invertResult?: boolean;
	  }
	| { kind: "OutlookRenderTypeRule"; type: "Web" | "Outlook"; invertResult?: boolean }
	| { kind: "OutlookVersionRule"; version: "2003" | "2007" | "2010"; invertResult?: boolean }
	| { kind: "PageRule"; address: string; invertResult?: boolean }
	| {
			kind: "RecordPrivilegeRule";
			privilegeType:
				| "Create"
				| "Read"
				| "Write"
				| "Delete"
				| "Assign"
				| "Share"
				| "Append"
				| "AppendTo";
			appliesTo?: "PrimaryEntity";
			invertResult?: boolean;
	  }
	| { kind: "ReferencingAttributeRequiredRule"; invertResult?: boolean }
	| {
			// appliesTo REQUIRED = "SelectedEntity"
			kind: "RelationshipTypeRule";
			appliesTo: "SelectedEntity";
			relationshipType?: "OneToMany" | "ManyToMany" | "NoRelationship";
			allowCustomRelationship?: boolean;
			allowSystemRelationship?: boolean;
			invertResult?: boolean;
	  }
	| {
			kind: "SelectionCountRule";
			minimum?: number;
			maximum?: number;
			appliesTo?: "PrimaryEntity" | "SelectedEntity";
			invertResult?: boolean;
	  }
	| { kind: "ShowOnQuickActionRule" }
	| { kind: "ShowOnGridAndQuickActionRule" }
	| { kind: "ShowOnGridRule" }
	| { kind: "SkuRule"; sku: "OnPremise" | "Online" | "Spla"; invertResult?: boolean }
	| {
			kind: "ValueRule";
			field: string;
			value: string;
			invertResult?: boolean;
	  };

export type EntityProperty =
	| "DuplicateDetectionEnabled"
	| "GridFiltersEnabled"
	| "HasStateCode"
	| "IsConnectionsEnabled"
	| "MailMergeEnabled"
	| "WorksWithQueue"
	| "HasActivities"
	| "IsActivity"
	| "HasNotes"
	| "IsCustomizable"
	| "IsActivityParty"
	| "HasEmailAddresses"
	| "IsChildEntity"
	| "IsImportable"
	| "IsEnabledForCharts"
	| "IsBusinessProcessEnabled"
	| "HasFeedback"
	| "IsBPFEntity";

export interface TabDisplayRule {
	tabCommand: string;
	sourceXml?: string;
	rules: TabDisplayRuleStep[];
}

export type TabDisplayRuleStep =
	| {
			kind: "EntityRule";
			entityName?: string;
			appliesTo?: "PrimaryEntity" | "SelectedEntity";
			context?: "Form" | "HomePageGrid" | "SubGridStandard" | "SubGridAssociated";
	  }
	| { kind: "PageRule"; address: string };

export interface LocLabel {
	id: string;
	sourceXml?: string;
	titles: { languageCode: number; description: string }[];
}

export interface ScalingDefinition {
	tabId: string;
	sourceXml?: string;
	maxSizes: ScaleStep[];
	scales: ScaleStep[];
}

export interface ScaleStep {
	id: string;
	groupId: string;
	size: string;
	sequence: number;
}

export interface HideCustomAction {
	hideActionId: string;
	location: string;
}

export interface GroupTemplate {
	id: string;
	name: string;
	layouts: GroupTemplateLayout[];
}

export interface GroupTemplateLayout {
	title: string;
	templateAlias: string;
	isOverflow: boolean;
}

export interface ConflictEntry {
	elementId: string;
	elementKind: "button" | "group" | "tab";
	solutions: ConflictSolutionLayer[];
}

export interface ConflictSolutionLayer {
	solutionId: string;
	solutionName: string;
	publisher: string;
	managed: boolean;
	importedOn?: string;
	wins: boolean;
}
