import type {
	RibbonButton,
	RibbonGroup,
	RibbonTab,
	RibbonDefinition,
	RibbonLocation,
	CommandDefinition,
	EnableRule,
	DisplayRule,
	LocLabel,
	TabDisplayRule,
	RuleStep,
	ActionParameter,
	JavaScriptAction,
	UrlAction,
	RibbonAction,
	EntityProperty,
	ScalingDefinition,
} from "@/types/ribbon";
import { resolveDisplayLabel } from "@/utils/displayLabel";
import { applyButtonOrigin, heuristicOrigin } from "@/utils/ribbonProvenance";

/**
 * Parses a fully-merged ribbon XML (from RetrieveEntityRibbon / RetrieveApplicationRibbon)
 * into the CBS internal data model.
 */
export function parseRibbonXml(
	xml: string,
	location: RibbonLocation,
	entityLogicalName: string,
): {
	ribbon: RibbonDefinition;
	commands: CommandDefinition[];
	displayRules: DisplayRule[];
	enableRules: EnableRule[];
	locLabels: LocLabel[];
} {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, "application/xml");

	const parseError = doc.querySelector("parsererror");
	if (parseError) {
		throw new Error(`Ribbon XML parse error: ${parseError.textContent ?? "Unknown"}`);
	}

	const tabs = parseTabs(doc);
	// TabDisplayRules live at document root under RuleDefinitions > TabDisplayRules,
	// not inside <Tab> elements. Apply them after all tabs are built.
	applyTabDisplayRules(doc, tabs);
	const commands = parseCommands(doc);
	const enableRules = parseEnableRules(doc);
	const displayRules = parseDisplayRules(doc);
	const locLabels = parseLocLabels(doc);
	const scalingByTab = parseScalings(doc);

	// Build set of customized element IDs from CustomAction elements
	const customActionIds = new Set<string>();
	const hideActionIds = new Set<string>();

	doc.querySelectorAll("CustomAction").forEach((ca) => {
		const def = ca.querySelector("CommandUIDefinition");
		if (def?.firstElementChild) {
			const id = def.firstElementChild.getAttribute("Id") ?? "";
			if (id) customActionIds.add(id);
		}
	});

	doc.querySelectorAll("HideCustomAction").forEach((h) => {
		const loc = h.getAttribute("Location") ?? "";
		if (loc) hideActionIds.add(loc);
	});

	// Mark provenance (heuristic — refined later by solution-layer data) and
	// resolve label / tooltip text.
	//
	// Labels arrive as raw ribbon tokens (`$LocLabels:<id>`, `$Resources:<key>`,
	// or literal). We resolve them to human-readable text here (now that
	// `locLabels` is parsed) so `button.label` is ALWAYS display text — the
	// canvas shows "Save", not "Mscrm.…LabelText", and the generator can
	// round-trip a loaded custom button's label back into a proper <LocLabel>.
	//
	// Provenance is a best-effort heuristic at parse time; authoritative
	// OOB/managed/unmanaged comes from ribbonProvenanceService and is overlaid
	// after load (see applyProvenanceToRibbons).
	for (const tab of tabs) {
		tab.label = resolveDisplayLabel(tab.label, locLabels);
		for (const group of tab.groups) {
			group.label = resolveDisplayLabel(group.label, locLabels);
			for (const button of group.buttons) {
				const inCustomAction = customActionIds.has(button.id);
				applyButtonOrigin(button, {
					origin: heuristicOrigin(button.id, inCustomAction),
				});
				button.hidden = hideActionIds.has(button.id);
				button.label = resolveDisplayLabel(button.label, locLabels);
				if (button.tooltipTitle) {
					button.tooltipTitle = resolveDisplayLabel(button.tooltipTitle, locLabels);
				}
				if (button.tooltipBody) {
					button.tooltipBody = resolveDisplayLabel(button.tooltipBody, locLabels);
				}
			}
		}
	}

	return {
		ribbon: { location, entityLogicalName, tabs, ...(Object.keys(scalingByTab).length ? { scalingByTab } : {}) },
		commands,
		displayRules,
		enableRules,
		locLabels,
	};
}

// ---------------------------------------------------------------------------
// Tabs / Groups / Buttons
// ---------------------------------------------------------------------------

function parseTabs(doc: Document): RibbonTab[] {
	const tabs: RibbonTab[] = [];

	// CustomAction > CommandUIDefinition can contain a second <Tab> with
	// identical Id. Those are declarations, not additional displayed tabs.
	// Subgrid tabs are rendered inside a ContextualGroup on native Dynamics;
	// they are still the same tab/group/control model, not customization declarations.
	doc.querySelectorAll("Tabs > Tab, ContextualTabs > ContextualGroup > Tab").forEach((tabEl) => {
		if (tabEl.closest("CustomAction, CommandUIDefinition")) return;
		const id = tabEl.getAttribute("Id") ?? "";
		if (!id) return;
		const label = tabEl.getAttribute("Title") ?? id;

		const groups: RibbonGroup[] = [];
		tabEl.querySelectorAll(":scope > Groups > Group").forEach((groupEl) => {
			const groupId = groupEl.getAttribute("Id") ?? "";
			if (!groupId) return;
			const groupLabel = groupEl.getAttribute("Title") ?? groupEl.getAttribute("Label") ?? groupId;
			const groupSeq = parseInt(groupEl.getAttribute("Sequence") ?? "0", 10);
			const template = groupEl.getAttribute("Template") ?? "";

			const buttons: RibbonButton[] = [];
			groupEl
				.querySelectorAll(":scope > Controls > Button, :scope > Controls > FlyoutAnchor, :scope > Controls > SplitButton, :scope > Controls > TextBox, :scope > Controls > ComboBox, :scope > Controls > CheckBox")
				.forEach((btnEl) => parseButtonElement(btnEl, buttons));

			groups.push({
				id: groupId,
				sourceXml: new XMLSerializer().serializeToString(groupEl),
				label: groupLabel,
				sequence: groupSeq,
				template,
				buttons,
			});
		});

		tabs.push({
			id,
			sourceXml: new XMLSerializer().serializeToString(tabEl),
			label,
			sequence: parseInt(tabEl.getAttribute("Sequence") ?? "0", 10),
			commandId: tabEl.getAttribute("Command") ?? undefined,
			template: tabEl.getAttribute("Template") ?? undefined,
			tabDisplayRules: [], // populated later by applyTabDisplayRules()
			groups,
		});
	});

	return tabs.sort((a, b) => a.sequence - b.sequence);
}

/**
 * TabDisplayRules are stored at document root under
 * <RuleDefinitions><TabDisplayRules> — NOT inside <Tab> elements.
 * They bind to a tab by matching TabCommand → Tab.commandId.
 * This function overlays them onto the already-parsed tabs.
 */
function applyTabDisplayRules(doc: Document, tabs: RibbonTab[]): void {
	const tabsByCommandId = new Map<string, RibbonTab>();
	for (const tab of tabs) {
		if (tab.commandId) tabsByCommandId.set(tab.commandId, tab);
	}

	doc.querySelectorAll("RuleDefinitions > TabDisplayRules > TabDisplayRule").forEach((tdr) => {
		const tabCommand = tdr.getAttribute("TabCommand") ?? "";
		const target = tabsByCommandId.get(tabCommand);
		if (!target) return;

		const rules: TabDisplayRule["rules"] = [];
		tdr.querySelectorAll(":scope > DisplayRules > EntityRule, :scope > EntityRule").forEach((er) => {
			rules.push({
				kind: "EntityRule",
				entityName: er.getAttribute("EntityName") ?? undefined,
				appliesTo: (er.getAttribute("AppliesTo") ?? undefined) as
					| "PrimaryEntity"
					| "SelectedEntity"
					| undefined,
				context: (er.getAttribute("Context") ?? undefined) as
					| "Form"
					| "HomePageGrid"
					| "SubGridStandard"
					| "SubGridAssociated"
					| undefined,
			});
		});
		tdr.querySelectorAll(":scope > DisplayRules > PageRule, :scope > PageRule").forEach((pr) => {
			rules.push({ kind: "PageRule", address: pr.getAttribute("Address") ?? "" });
		});
		if (rules.length > 0) {
			target.tabDisplayRules.push({ tabCommand, rules, sourceXml: new XMLSerializer().serializeToString(tdr) });
		}
	});
}

function parseButtonElement(el: Element, out: RibbonButton[]) {
	const id = el.getAttribute("Id") ?? "";
	if (!id) return;

	const tagName = el.tagName.toLowerCase();
	let kind: RibbonButton["kind"] = "button";
	if (tagName === "flyoutanchor") kind = "flyout";
	else if (tagName === "splitbutton") kind = "splitButton";
	else if (tagName === "textbox") kind = "textBox";
	else if (tagName === "combobox") kind = "comboBox";
	else if (tagName === "checkbox") kind = "checkBox";

	// Keep the raw LabelText token (`$LocLabels:…` / `$Resources:…` / literal);
	// it is resolved to display text in parseRibbonXml once LocLabels are known.
	const label = el.getAttribute("LabelText") ?? id;
	const modernImage = el.getAttribute("ModernImage") ?? undefined;
	const icon = modernImage?.startsWith("$webresource:") || modernImage?.startsWith("$Resources:")
		? modernImage
		: normalizeFluentIconName(modernImage);
	const sequence = parseInt(el.getAttribute("Sequence") ?? "0", 10);
	const templateAlias = el.getAttribute("TemplateAlias") ?? "";
	const commandId = el.getAttribute("Command") ?? "";

	out.push({
		id,
		sourceXml: new XMLSerializer().serializeToString(el),
		label,
		icon,
		sequence,
		templateAlias,
		commandId,
		kind,
		hidden: false,
		oob: true,
		custom: false,
		managed: false,
		tooltipTitle: el.getAttribute("ToolTipTitle") ?? undefined,
		tooltipBody: el.getAttribute("ToolTipDescription") ?? undefined,
		image16: el.getAttribute("Image16by16") ?? undefined,
		image32: el.getAttribute("Image32by32") ?? undefined,
	});
}

function normalizeFluentIconName(iconName?: string): string | undefined {
	if (!iconName) return undefined;
	if (iconName.includes("_")) return iconName.toLowerCase();
	return iconName
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseCommands(doc: Document): CommandDefinition[] {
	const commands: CommandDefinition[] = [];

	doc.querySelectorAll("CommandDefinition").forEach((cmdEl) => {
		const id = cmdEl.getAttribute("Id") ?? "";
		if (!id) return;

		const enableRules: string[] = [];
		cmdEl.querySelectorAll("EnableRule").forEach((r) => {
			const rid = r.getAttribute("Id");
			if (rid) enableRules.push(rid);
		});

		const displayRules: string[] = [];
		cmdEl.querySelectorAll("DisplayRule").forEach((r) => {
			const rid = r.getAttribute("Id");
			if (rid) displayRules.push(rid);
		});

		const actions: RibbonAction[] = [];

		// A ribbon command can interleave JS and URL actions; execution order
		// is significant, so parse them in DOM order rather than by action type.
		cmdEl.querySelectorAll(":scope > Actions > *").forEach((actionEl) => {
			if (actionEl.tagName === "JavaScriptFunction") {
				const library = actionEl.getAttribute("Library") ?? "";
				const functionName = actionEl.getAttribute("FunctionName") ?? "";
				const params: ActionParameter[] = parseActionParams(actionEl);
				const action: JavaScriptAction = { kind: "javascript", library, functionName, params };
				actions.push(action);
			} else if (actionEl.tagName === "Url") {
				const address = actionEl.getAttribute("Address") ?? "";
				const passParams =
					actionEl.getAttribute("PassParams") === "1" || actionEl.getAttribute("PassParams") === "true";
				const winMode = parseInt(actionEl.getAttribute("WinMode") ?? "0", 10) as 0 | 1 | 2;
				const params: ActionParameter[] = parseActionParams(actionEl);
				const action: UrlAction = { kind: "url", address, passParams, winMode, params };
				actions.push(action);
			}
		});

		commands.push({ id, enableRules, displayRules, actions, sourceXml: new XMLSerializer().serializeToString(cmdEl) });
	});

	return commands;
}

function parseActionParams(el: Element): ActionParameter[] {
	const params: ActionParameter[] = [];

	el.childNodes.forEach((child) => {
		if (child.nodeType !== Node.ELEMENT_NODE) return;
		const c = child as Element;
		switch (c.tagName) {
			case "CrmParameter":
				params.push({
					kind: "CrmParameter",
					name: c.getAttribute("Name") ?? undefined,
					value: c.getAttribute("Value") as import("@/types/ribbon").CrmParameterValue,
				});
				break;
			case "BoolParameter":
				params.push({
					kind: "BoolParameter",
					name: c.getAttribute("Name") ?? undefined,
					value: c.getAttribute("Value") === "true" || c.getAttribute("Value") === "1",
				});
				break;
			case "IntParameter":
				params.push({
					kind: "IntParameter",
					name: c.getAttribute("Name") ?? undefined,
					value: parseInt(c.getAttribute("Value") ?? "0", 10),
				});
				break;
			case "DecimalParameter":
				params.push({
					kind: "DecimalParameter",
					name: c.getAttribute("Name") ?? undefined,
					value: parseFloat(c.getAttribute("Value") ?? "0"),
				});
				break;
			case "StringParameter":
				params.push({
					kind: "StringParameter",
					name: c.getAttribute("Name") ?? undefined,
					value: c.getAttribute("Value") ?? "",
				});
				break;
		}
	});

	return params;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function parseEnableRules(doc: Document): EnableRule[] {
	const rules: EnableRule[] = [];
	doc.querySelectorAll("RuleDefinitions > EnableRules > EnableRule").forEach((rEl) => {
		const id = rEl.getAttribute("Id") ?? "";
		if (!id) return;
		const steps = parseRuleSteps(rEl);
		rules.push({ id, steps, sourceXml: new XMLSerializer().serializeToString(rEl) });
	});
	return rules;
}

function parseDisplayRules(doc: Document): DisplayRule[] {
	const rules: DisplayRule[] = [];
	doc.querySelectorAll("RuleDefinitions > DisplayRules > DisplayRule").forEach((rEl) => {
		const id = rEl.getAttribute("Id") ?? "";
		if (!id) return;
		const steps = parseRuleSteps(rEl);
		rules.push({ id, steps, sourceXml: new XMLSerializer().serializeToString(rEl) });
	});
	return rules;
}

function parseRuleSteps(ruleEl: Element): RuleStep[] {
	const steps: RuleStep[] = [];
	ruleEl.childNodes.forEach((child) => {
		if (child.nodeType !== Node.ELEMENT_NODE) return;
		const el = child as Element;
		const invert =
			el.getAttribute("InvertResult") === "1" || el.getAttribute("InvertResult") === "true";
		const step = parseRuleStep(el, invert);
		if (step) steps.push(step);
	});
	return steps;
}

function parseRuleStep(el: Element, invertResult: boolean): RuleStep | null {
	switch (el.tagName) {
		case "SelectionCountRule":
			return {
				kind: "SelectionCountRule",
				minimum: el.getAttribute("Minimum") ? parseInt(el.getAttribute("Minimum")!, 10) : undefined,
				maximum: el.getAttribute("Maximum") ? parseInt(el.getAttribute("Maximum")!, 10) : undefined,
				appliesTo: el.getAttribute("AppliesTo") as "PrimaryEntity" | "SelectedEntity" | undefined,
				invertResult,
			};
		case "EntityRule":
			return {
				kind: "EntityRule",
				entityName: el.getAttribute("EntityName") ?? undefined,
				context: el.getAttribute("Context") ?? undefined,
				appliesTo: el.getAttribute("AppliesTo") as "PrimaryEntity" | "SelectedEntity" | undefined,
				invertResult,
			};
		case "FormStateRule":
			return {
				kind: "FormStateRule",
				state: el.getAttribute("State") as
					| "Create"
					| "Existing"
					| "ReadOnly"
					| "Disabled"
					| "BulkEdit",
				invertResult,
			};
		case "CommandClientTypeRule":
			return {
				kind: "CommandClientTypeRule",
				type: el.getAttribute("Type") as "Modern" | "Refresh" | "Legacy",
				default: el.getAttribute("Default") === "true",
				invertResult,
			};
		case "CustomRule":
			return {
				kind: "CustomRule",
				library: el.getAttribute("Library") ?? "",
				functionName: el.getAttribute("FunctionName") ?? "",
				default: el.getAttribute("Default") === "true",
				invertResult,
			};
		case "OrRule": {
			const nested: RuleStep[] = [];
			el.querySelectorAll("Or").forEach((orEl) => {
				orEl.childNodes.forEach((c) => {
					if (c.nodeType === Node.ELEMENT_NODE) {
						const s = parseRuleStep(c as Element, false);
						if (s) nested.push(s);
					}
				});
			});
			return { kind: "OrRule", rules: nested };
		}
		case "MiscellaneousPrivilegeRule":
			return {
				kind: "MiscellaneousPrivilegeRule",
				privilegeName: el.getAttribute("PrivilegeName") ?? "",
				invertResult,
			};
		case "CrmClientTypeRule":
			return {
				kind: "CrmClientTypeRule",
				type: el.getAttribute("Type") as "Web" | "Outlook",
				invertResult,
			};
		case "FormTypeRule":
			return {
				kind: "FormTypeRule",
				type: el.getAttribute("Type") as
					| "Main"
					| "Preview"
					| "AppointmentBook"
					| "Dashboard"
					| "Quick"
					| "QuickCreate"
					| "Card"
					| "MainInteractionCentric",
				invertResult,
			};
		case "ValueRule":
			return {
				kind: "ValueRule",
				field: el.getAttribute("Field") ?? "",
				value: el.getAttribute("Value") ?? "",
				invertResult,
			};
		case "SkuRule":
			return {
				kind: "SkuRule",
				sku: el.getAttribute("Sku") as "OnPremise" | "Online" | "Spla",
				invertResult,
			};
		case "HideForTabletExperienceRule":
			return { kind: "HideForTabletExperienceRule", invertResult };
		case "OrganizationSettingRule":
			return {
				kind: "OrganizationSettingRule",
				setting: el.getAttribute("Setting") as
					| "IsSharepointEnabled"
					| "IsSOPIntegrationEnabled"
					| "IsFiscalCalendarDefined"
					| "IsReadFormModeDefined"
					| "IsBPFEntityCustomizationFeatureEnabled",
				invertResult,
			};
		// ── Display-rule-only kinds ─────────────────────────────────────────
		case "EntityPrivilegeRule":
			return {
				kind: "EntityPrivilegeRule",
				entityName: el.getAttribute("EntityName") ?? undefined,
				appliesTo: (el.getAttribute("AppliesTo") ?? undefined) as
					| "PrimaryEntity"
					| "SelectedEntity"
					| undefined,
				privilegeType: el.getAttribute("PrivilegeType") as
					| "Create"
					| "Read"
					| "Write"
					| "Delete"
					| "Assign"
					| "Share"
					| "Append"
					| "AppendTo",
				privilegeDepth: (el.getAttribute("PrivilegeDepth") ?? "Basic") as
					| "None"
					| "Basic"
					| "Local"
					| "Deep"
					| "Global",
				invertResult,
			};
		case "EntityPropertyRule":
			return {
				kind: "EntityPropertyRule",
				entityName: el.getAttribute("EntityName") ?? undefined,
				appliesTo: (el.getAttribute("AppliesTo") ?? undefined) as
					| "PrimaryEntity"
					| "SelectedEntity"
					| undefined,
				propertyName: el.getAttribute("PropertyName") as EntityProperty,
				propertyValue:
					el.getAttribute("PropertyValue") === "true" || el.getAttribute("PropertyValue") === "1",
				invertResult,
			};
		case "DeviceTypeRule":
			return {
				kind: "DeviceTypeRule",
				type: el.getAttribute("Type") as
					| "None"
					| "Phone"
					| "Tablet"
					| "Web"
					| "Outlook"
					| "InteractionCentric",
				invertResult,
			};
		case "OptionSetRule":
			return {
				kind: "OptionSetRule",
				optionSet: el.getAttribute("OptionSet") ?? "",
				stateCode: el.getAttribute("StateCode") ?? "",
				objectTypeCode: el.getAttribute("ObjectTypeCode") ?? "",
				invertResult,
			};
		// ── Rules valid in both Enable and Display contexts ─────────────────
		case "RecordPrivilegeRule":
			return {
				kind: "RecordPrivilegeRule",
				privilegeType: el.getAttribute("PrivilegeType") as
					| "Create"
					| "Read"
					| "Write"
					| "Delete"
					| "Assign"
					| "Share"
					| "Append"
					| "AppendTo",
				appliesTo: (el.getAttribute("AppliesTo") ?? undefined) as "PrimaryEntity" | undefined,
				invertResult,
			};
		case "FormEntityContextRule":
			return {
				kind: "FormEntityContextRule",
				entityName: el.getAttribute("EntityName") ?? "",
				invertResult,
			};
		case "PageRule":
			return {
				kind: "PageRule",
				address: el.getAttribute("Address") ?? "",
				invertResult,
			};
		case "RelationshipTypeRule":
			return {
				kind: "RelationshipTypeRule",
				// Schema requires AppliesTo="SelectedEntity" — default if missing.
				appliesTo: "SelectedEntity",
				relationshipType: (el.getAttribute("RelationshipType") ?? undefined) as
					| "OneToMany"
					| "ManyToMany"
					| "NoRelationship"
					| undefined,
				allowCustomRelationship: el.hasAttribute("AllowCustomRelationship")
					? el.getAttribute("AllowCustomRelationship") !== "false"
					: undefined,
				allowSystemRelationship: el.hasAttribute("AllowSystemRelationship")
					? el.getAttribute("AllowSystemRelationship") !== "false"
					: undefined,
				invertResult,
			};
		case "ReferencingAttributeRequiredRule":
			return { kind: "ReferencingAttributeRequiredRule", invertResult };
		// ── Quick-action OOB rule references ───────────────────────────────
		case "ShowOnQuickActionRule":
			return { kind: "ShowOnQuickActionRule" };
		case "ShowOnGridAndQuickActionRule":
			return { kind: "ShowOnGridAndQuickActionRule" };
		case "ShowOnGridRule":
			return { kind: "ShowOnGridRule" };
		// ── Outlook-specific rules ──────────────────────────────────────────
		case "OutlookItemTrackingRule":
			return {
				kind: "OutlookItemTrackingRule",
				trackedInCrm:
					el.getAttribute("TrackedInCrm") === "true" || el.getAttribute("TrackedInCrm") === "1",
				appliesTo: (el.getAttribute("AppliesTo") ?? undefined) as "PrimaryEntity" | undefined,
				invertResult,
			};
		case "OutlookRenderTypeRule":
			return {
				kind: "OutlookRenderTypeRule",
				type: el.getAttribute("Type") as "Web" | "Outlook",
				invertResult,
			};
		case "OutlookVersionRule":
			return {
				kind: "OutlookVersionRule",
				version: el.getAttribute("Version") as "2003" | "2007" | "2010",
				invertResult,
			};
		case "CrmOfflineAccessStateRule":
			return {
				kind: "CrmOfflineAccessStateRule",
				state: el.getAttribute("State") as "Offline" | "Online",
				invertResult,
			};
		case "CrmOutlookClientTypeRule":
			return {
				kind: "CrmOutlookClientTypeRule",
				type: el.getAttribute("Type") as "CrmForOutlook" | "CrmForOutlookOfflineAccess",
				invertResult,
			};
		case "CrmOutlookClientVersionRule":
			return {
				kind: "CrmOutlookClientVersionRule",
				major: parseInt(el.getAttribute("Major") ?? "0", 10),
				minor: el.hasAttribute("Minor") ? parseInt(el.getAttribute("Minor")!, 10) : undefined,
				build: el.hasAttribute("Build") ? parseInt(el.getAttribute("Build")!, 10) : undefined,
				revision: el.hasAttribute("Revision")
					? parseInt(el.getAttribute("Revision")!, 10)
					: undefined,
				invertResult,
			};
		default:
			// Unknown rule kind — return null so it's silently skipped rather than
			// corrupting the in-memory rule with an unrecognised step.
			return null;
	}
}

// ---------------------------------------------------------------------------
// LocLabels
// ---------------------------------------------------------------------------

function parseLocLabels(doc: Document): LocLabel[] {
	const labels: LocLabel[] = [];
	doc.querySelectorAll("LocLabel").forEach((lEl) => {
		const id = lEl.getAttribute("Id") ?? "";
		if (!id) return;
		const titles: LocLabel["titles"] = [];
		lEl.querySelectorAll("Title").forEach((t) => {
			const langCode = parseInt(t.getAttribute("languagecode") ?? "1033", 10);
			const description = t.getAttribute("description") ?? "";
			titles.push({ languageCode: langCode, description });
		});
		labels.push({ id, titles, sourceXml: new XMLSerializer().serializeToString(lEl) });
	});
	return labels;
}

/** Ribbon XML can express scalings inside tabs or in an outer Scalings block. */
function parseScalings(doc: Document): Record<string, ScalingDefinition> {
	const result: Record<string, ScalingDefinition> = {};
	doc.querySelectorAll("Scaling").forEach((el) => {
		const tabId = el.getAttribute("TabId") ?? el.closest("Tab")?.getAttribute("Id") ?? "";
		if (!tabId) return;
		const steps = (tag: "MaxSize" | "Scale") => [...el.querySelectorAll(`:scope > ${tag}`)].map((step) => ({
			id: step.getAttribute("Id") ?? "",
			groupId: step.getAttribute("GroupId") ?? "",
			size: step.getAttribute("Size") ?? "",
			sequence: Number(step.getAttribute("Sequence") ?? 0),
		}));
		result[tabId] = {
			tabId,
			maxSizes: steps("MaxSize"),
			scales: steps("Scale"),
			sourceXml: new XMLSerializer().serializeToString(el),
		};
	});
	return result;
}
