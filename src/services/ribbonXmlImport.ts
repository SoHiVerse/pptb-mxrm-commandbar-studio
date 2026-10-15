import { parseXmlStrict, serializeXml } from "@/services/ribbonMerge";
import { parseRibbonXml } from "@/services/xmlParser";
import { resolveDisplayLabel } from "@/utils/displayLabel";
import type {
	CommandDefinition, DisplayRule, EnableRule, LocLabel, RibbonButton,
	RibbonDefinition, RibbonGroup, RibbonLocation, RibbonTab, TabDisplayRule,
} from "@/types/ribbon";
import type { RibbonWorkspace } from "@/types/workspace";

const CONTROL_TAGS = new Set(["Button", "FlyoutAnchor", "SplitButton", "TextBox", "ComboBox", "CheckBox"]);
const RULE_TAGS = new Set([
	"SelectionCountRule", "EntityRule", "FormStateRule", "CommandClientTypeRule", "CrmClientTypeRule",
	"CustomRule", "OrRule", "MiscellaneousPrivilegeRule", "FormTypeRule", "ValueRule", "SkuRule",
	"HideForTabletExperienceRule", "OrganizationSettingRule", "EntityPrivilegeRule", "EntityPropertyRule",
	"DeviceTypeRule", "RelationshipTypeRule", "RecordPrivilegeRule", "FormEntityContextRule", "PageRule",
	"ShowOnQuickActionRule", "ShowOnGridAndQuickActionRule", "ShowOnGridRule", "ReferencingAttributeRequiredRule",
	"OutlookItemTrackingRule", "OutlookRenderTypeRule", "OutlookVersionRule", "CrmOfflineAccessStateRule",
	"CrmOutlookClientTypeRule", "CrmOutlookClientVersionRule", "OptionSetRule",
]);
const PARAMETER_TAGS = new Set(["CrmParameter", "BoolParameter", "IntParameter", "DecimalParameter", "StringParameter"]);
const ACTION_TAGS = new Set(["JavaScriptFunction", "Url"]);
const MODELED_CONTROL_ATTRIBUTES = new Set([
	"Id", "LabelText", "Command", "Sequence", "TemplateAlias", "ToolTipTitle", "ToolTipDescription",
	"ModernImage", "Image16by16", "Image32by32",
]);
const RULE_ATTRS = new Set([
	"Minimum", "Maximum", "AppliesTo", "InvertResult", "EntityName", "Context", "State", "Type", "Default",
	"Library", "FunctionName", "PrivilegeName", "PrivilegeType", "PrivilegeDepth", "Field", "Value", "Sku",
	"Setting", "DeviceType", "PropertyName", "PropertyValue", "OptionSet", "StateCode", "ObjectTypeCode",
	"RelationshipType", "AllowCustomRelationship", "AllowSystemRelationship", "Address", "TrackedInCrm",
	"Version", "Major", "Minor", "Build", "Revision",
]);

function children(parent: ParentNode, name?: string): Element[] {
	return Array.from(parent.childNodes)
		.filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
		.filter(node => !name || node.tagName === name);
}

function only(parent: ParentNode, name: string): Element | null {
	const elements = children(parent, name);
	if (elements.length > 1) throw new Error(`Ambiguous duplicate <${name}> section in imported ribbon XML.`);
	return elements[0] ?? null;
}

function requiredAttr(el: Element, attribute: string): string {
	const value = el.getAttribute(attribute)?.trim();
	if (!value) throw new Error(`<${el.tagName}> must declare ${attribute}.`);
	if (attribute === "Id" && /\s/.test(value)) throw new Error(`Element Id ${value} contains whitespace.`);
	return value;
}

function assertAllowedChildren(parent: Element, tags: ReadonlySet<string>): void {
	for (const item of children(parent)) {
		if (!tags.has(item.tagName)) throw new Error(`Unsupported <${item.tagName}> inside <${parent.tagName}>; import it through a supported command/action or edit the XML outside this visual editor.`);
	}
}

function assertAttributes(node: Element, permitted: ReadonlySet<string>): void {
	for (const { name } of Array.from(node.attributes)) {
		if (!permitted.has(name)) throw new Error(`Unsupported ${node.tagName} attribute ${name}; the visual editor cannot safely round-trip this extension.`);
	}
}

function assertDistinct(nodes: Element[], key: string, context: string): void {
	const seen = new Set<string>();
	for (const node of nodes) {
		const id = requiredAttr(node, key);
		if (seen.has(id)) throw new Error(`Duplicate ${context} ${id} in imported XML.`);
		seen.add(id);
	}
}

function checkNumeric(raw: string | null, context: string, allowDecimal = false): void {
	if (raw === null || !(allowDecimal ? /^-?(?:\d+)(?:\.\d+)?$/.test(raw) : /^-?\d+$/.test(raw)) || !Number.isFinite(Number(raw))) {
		throw new Error(`Invalid ${context} numeric value.`);
	}
}

function validateSequence(element: Element): void {
	if (!element.hasAttribute("Sequence")) return;
	checkNumeric(element.getAttribute("Sequence"), `${element.tagName}.Sequence`);
	if (Number(element.getAttribute("Sequence")) < 0) throw new Error(`${element.tagName}.Sequence cannot be negative.`);
}

function validateParameter(parameter: Element): void {
	if (!PARAMETER_TAGS.has(parameter.tagName)) throw new Error(`Unsupported command parameter <${parameter.tagName}>.`);
	assertAttributes(parameter, new Set(["Name", "Value"]));
	requiredAttr(parameter, "Value");
	if (children(parameter).length) throw new Error("Nested action parameters are not supported.");
	if (parameter.tagName === "IntParameter") checkNumeric(parameter.getAttribute("Value"), "IntParameter");
	if (parameter.tagName === "DecimalParameter") checkNumeric(parameter.getAttribute("Value"), "DecimalParameter", true);
	if (parameter.tagName === "BoolParameter" && !["1", "0", "true", "false"].includes(requiredAttr(parameter, "Value"))) {
		throw new Error("BoolParameter Value must be true, false, 1, or 0.");
	}
}

function validateCommand(node: Element): void {
	requiredAttr(node, "Id");
	assertAllowedChildren(node, new Set(["EnableRules", "DisplayRules", "Actions"]));
	for (const refKind of ["EnableRules", "DisplayRules"] as const) {
		const section = only(node, refKind);
		if (!section) continue;
		const refTag = refKind === "EnableRules" ? "EnableRule" : "DisplayRule";
		assertAllowedChildren(section, new Set([refTag]));
		assertDistinct(children(section), "Id", `${refKind} reference`);
		for (const ref of children(section)) assertAttributes(ref, new Set(["Id"]));
	}
	const actions = only(node, "Actions");
	if (!actions) return;
	assertAllowedChildren(actions, ACTION_TAGS);
	for (const action of children(actions)) {
		if (action.tagName === "JavaScriptFunction") {
			assertAttributes(action, new Set(["Library", "FunctionName"]));
			requiredAttr(action, "Library");
			requiredAttr(action, "FunctionName");
		} else {
			assertAttributes(action, new Set(["Address", "PassParams", "WinMode"]));
			requiredAttr(action, "Address");
			if (action.hasAttribute("WinMode") && !["0", "1", "2"].includes(action.getAttribute("WinMode")!)) {
				throw new Error("Url WinMode must be 0, 1 or 2.");
			}
			if (action.hasAttribute("PassParams") && !["0", "1", "true", "false"].includes(action.getAttribute("PassParams")!)) {
				throw new Error("Url PassParams must be boolean.");
			}
		}
		for (const parameter of children(action)) validateParameter(parameter);
	}
}

function validateRuleStep(step: Element): void {
	if (!RULE_TAGS.has(step.tagName)) throw new Error(`Unsupported rule step <${step.tagName}>; importing it would silently drop behavior.`);
	assertAttributes(step, RULE_ATTRS);
	if (step.tagName === "OrRule") {
		assertAllowedChildren(step, new Set(["Or"]));
		const ors = children(step);
		if (ors.length < 2) throw new Error("OrRule requires at least two Or branches.");
		for (const or of ors) {
			assertAttributes(or, new Set());
			if (children(or).length !== 1) throw new Error("Each Or branch must contain exactly one supported rule step to preserve grouping.");
			validateRuleStep(children(or)[0]);
		}
	} else if (children(step).length) {
		throw new Error(`Unexpected nested elements inside ${step.tagName}.`);
	}
	for (const attribute of ["Minimum", "Maximum", "Major", "Minor", "Build", "Revision"] as const) {
		if (step.hasAttribute(attribute)) checkNumeric(step.getAttribute(attribute), `${step.tagName}.${attribute}`);
	}
}

function validateRule(rule: Element): void {
	requiredAttr(rule, "Id");
	for (const step of children(rule)) validateRuleStep(step);
}

function validateTabDisplayRule(rule: Element): void {
	requiredAttr(rule, "TabCommand");
	assertAttributes(rule, new Set(["TabCommand"]));
	assertAllowedChildren(rule, new Set(["DisplayRules"]));
	const section = only(rule, "DisplayRules");
	if (!section) throw new Error("TabDisplayRule requires a DisplayRules section.");
	assertAllowedChildren(section, new Set(["EntityRule", "PageRule"]));
	if (!children(section).length) throw new Error("An empty TabDisplayRule would be silently omitted by the ribbon parser.");
	for (const item of children(section)) validateRuleStep(item);
}

function validateLabels(section: Element): void {
	assertAllowedChildren(section, new Set(["LocLabel"]));
	assertDistinct(children(section), "Id", "LocLabel");
	for (const label of children(section)) {
		assertAttributes(label, new Set(["Id"]));
		assertAllowedChildren(label, new Set(["Titles"]));
		const titles = only(label, "Titles");
		if (!titles || children(titles).length === 0) throw new Error(`LocLabel ${requiredAttr(label, "Id")} must have localized Title elements.`);
		assertAllowedChildren(titles, new Set(["Title"]));
		const locale = new Set<string>();
		for (const title of children(titles)) {
			assertAttributes(title, new Set(["languagecode", "description"]));
			const id = requiredAttr(title, "languagecode");
			checkNumeric(id, "languagecode");
			if (locale.has(id)) throw new Error(`Duplicate language ${id} in localized label.`);
			locale.add(id);
			if (!title.hasAttribute("description")) throw new Error("Localized Title must have description.");
		}
	}
}

function validateControlsMarkup(container: Element): void {
	assertAllowedChildren(container, CONTROL_TAGS);
	assertDistinct(children(container), "Id", "control");
	for (const item of children(container)) {
		// Nested menus are opaque but retained in the sourceXml of supported controls.
		// A plain Button has no safely representable nested authored extensions.
		if (item.tagName === "Button" && children(item).length) {
			throw new Error(`Nested markup inside Button ${requiredAttr(item, "Id")} is not supported by the visual editor.`);
		}
		requiredAttr(item, "Id");
		validateSequence(item);
	}
}

function validateGroupMarkup(group: Element): void {
	const id = requiredAttr(group, "Id");
	validateSequence(group);
	// Group.Command is not represented by RibbonGroup and the serializer does
	// not output it. Importing it would acknowledge behavior we cannot publish.
	assertAttributes(group, new Set(["Id", "Title", "Label", "Template", "Sequence"]));
	assertAllowedChildren(group, new Set(["Controls"]));
	const controls = only(group, "Controls");
	if (controls) {
		assertAttributes(controls, new Set(["Id"]));
		if (controls.hasAttribute("Id") && controls.getAttribute("Id") !== `${id}.Controls`) {
			throw new Error(`Unsupported Controls Id for ${id}: the ribbon generator cannot preserve a nonconventional controls identity.`);
		}
		validateControlsMarkup(controls);
		if (children(controls).length) {
			throw new Error(`Group ${requiredAttr(group, "Id")} embeds controls. Import buttons through separate CustomActions to preserve their placement.`);
		}
	}
}

function validateTabMarkup(tab: Element): void {
	const id = requiredAttr(tab, "Id");
	validateSequence(tab);
	assertAttributes(tab, new Set(["Id", "Title", "Label", "Sequence", "Command", "Template"]));
	assertAllowedChildren(tab, new Set(["Groups"]));
	const groups = only(tab, "Groups");
	if (groups) {
		assertAttributes(groups, new Set(["Id"]));
		if (groups.hasAttribute("Id") && groups.getAttribute("Id") !== `${id}.Groups`) {
			throw new Error(`Unsupported Groups Id for ${id}: the ribbon generator cannot preserve a nonconventional groups identity.`);
		}
		assertAllowedChildren(groups, new Set(["Group"]));
		assertDistinct(children(groups), "Id", "tab group");
		for (const group of children(groups)) validateGroupMarkup(group);
	}
}

function validateImport(root: Element): void {
	assertAllowedChildren(root, new Set(["CustomActions", "Templates", "CommandDefinitions", "RuleDefinitions", "LocLabels", "Scalings"]));
	for (const sectionName of ["CustomActions", "Templates", "CommandDefinitions", "RuleDefinitions", "LocLabels", "Scalings"]) {
		only(root, sectionName);
	}
	const templates = only(root, "Templates");
	if (templates) {
		assertAllowedChildren(templates, new Set(["RibbonTemplates"]));
		for (const template of children(templates)) {
			if (template.getAttribute("Id") !== "Mscrm.Templates" || children(template).length) {
				throw new Error("Custom ribbon Templates cannot be imported safely; use existing Mscrm.Templates and separate button actions.");
			}
			assertAttributes(template, new Set(["Id"]));
		}
	}
	const commands = only(root, "CommandDefinitions");
	if (commands) {
		assertAllowedChildren(commands, new Set(["CommandDefinition"]));
		assertDistinct(children(commands), "Id", "CommandDefinition");
		for (const command of children(commands)) validateCommand(command);
	}
	const rules = only(root, "RuleDefinitions");
	if (rules) {
		assertAllowedChildren(rules, new Set(["TabDisplayRules", "DisplayRules", "EnableRules"]));
		for (const [containerName, definitionName] of [
			["EnableRules", "EnableRule"], ["DisplayRules", "DisplayRule"], ["TabDisplayRules", "TabDisplayRule"],
		] as const) {
			const container = only(rules, containerName);
			if (!container) continue;
			assertAllowedChildren(container, new Set([definitionName]));
			assertDistinct(children(container), containerName === "TabDisplayRules" ? "TabCommand" : "Id", definitionName);
			for (const rule of children(container)) {
				if (containerName === "TabDisplayRules") validateTabDisplayRule(rule);
				else validateRule(rule);
			}
		}
	}
	const labels = only(root, "LocLabels");
	if (labels) validateLabels(labels);
	const scaling = only(root, "Scalings");
	if (scaling) {
		assertAllowedChildren(scaling, new Set(["Scaling"]));
		assertDistinct(children(scaling), "TabId", "Scaling");
		for (const entry of children(scaling)) {
			assertAttributes(entry, new Set(["TabId"]));
			assertAllowedChildren(entry, new Set(["Scale", "MaxSize"]));
			for (const step of children(entry)) {
				assertAttributes(step, new Set(["Id", "GroupId", "Size", "Sequence"]));
				requiredAttr(step, "GroupId");
				requiredAttr(step, "Size");
				if (step.hasAttribute("Sequence")) checkNumeric(step.getAttribute("Sequence"), "Scaling.Sequence");
			}
		}
	}
	const actions = only(root, "CustomActions");
	if (actions) {
		assertAllowedChildren(actions, new Set(["CustomAction", "HideCustomAction"]));
		assertDistinct(children(actions).filter(action => action.tagName === "CustomAction"), "Id", "CustomAction");
		assertDistinct(children(actions).filter(action => action.tagName === "HideCustomAction"), "HideActionId", "HideCustomAction");
		for (const action of children(actions)) {
			requiredAttr(action, "Location");
			if (action.tagName === "HideCustomAction") {
				assertAttributes(action, new Set(["HideActionId", "Location"]));
				if (children(action).length) throw new Error("HideCustomAction cannot contain nested elements.");
				continue;
			}
			assertAttributes(action, new Set(["Id", "Location", "Sequence"]));
			if (action.hasAttribute("Sequence")) checkNumeric(action.getAttribute("Sequence"), "CustomAction.Sequence");
			assertAllowedChildren(action, new Set(["CommandUIDefinition"]));
			const ui = only(action, "CommandUIDefinition");
			const payload = ui && children(ui);
			if (!payload || payload.length !== 1 || ![...CONTROL_TAGS, "Tab", "Group"].includes(payload[0].tagName)) {
				throw new Error(`CustomAction ${requiredAttr(action, "Id")} must contain exactly one supported control, Tab, or Group.`);
			}
			const element = payload[0];
			validateSequence(element);
			if (element.tagName === "Tab") validateTabMarkup(element);
			else if (element.tagName === "Group") validateGroupMarkup(element);
			else if (element.tagName === "Button" && children(element).length) {
				throw new Error(`Unsupported nested content in Button ${requiredAttr(element, "Id")}.`);
			}
			requiredAttr(element, "Id");
		}
	}

	// The shared XML parser deliberately searches the document for definition
	// elements. Reject declarations buried in opaque Flyout/Menu content so they
	// cannot be accidentally imported as global commands/rules/labels.
	for (const tag of ["CommandDefinition", "LocLabel", "TabDisplayRule", "Scaling", "EnableRule", "DisplayRule"]) {
		for (const element of Array.from(root.querySelectorAll(tag))) {
			const parent = element.parentElement;
			const ancestor = parent?.parentElement;
			const isRootSection = ancestor === root;
			const isRuleSection = ancestor?.tagName === "RuleDefinitions" && ancestor.parentElement === root;
			const isCommandReference = (tag === "EnableRule" || tag === "DisplayRule") &&
				ancestor?.tagName === "CommandDefinition" && ancestor.parentElement?.tagName === "CommandDefinitions" &&
				ancestor.parentElement.parentElement === root;
			const legal = tag === "CommandDefinition" ? parent?.tagName === "CommandDefinitions" && isRootSection :
				tag === "LocLabel" ? parent?.tagName === "LocLabels" && isRootSection :
					tag === "TabDisplayRule" ? parent?.tagName === "TabDisplayRules" && isRuleSection :
						tag === "Scaling" ? parent?.tagName === "Scalings" && isRootSection :
							(parent?.tagName === `${tag === "EnableRule" ? "Enable" : "Display"}Rules` && (isRuleSection || isCommandReference));
			if (!legal) throw new Error(`Unsupported nested <${tag}> declaration: import definitions only in their corresponding top-level ribbon sections.`);
		}
	}
}

function workspaceEntity(current: RibbonWorkspace, baseline: RibbonWorkspace, location: RibbonLocation): string {
	const entity = baseline.ribbons.Form?.entityLogicalName;
	if (!entity || !/^[a-z][a-z0-9_]*$/.test(entity)) {
		throw new Error("A loaded entity ribbon baseline is required before importing XML.");
	}
	for (const scope of ["HomepageGrid", "SubGrid", "Form"] as const) {
		if (current.ribbons[scope]?.entityLogicalName !== entity || baseline.ribbons[scope]?.entityLogicalName !== entity) {
			throw new Error("Ribbon workspace entity identity changed; reload the selected entity before importing XML.");
		}
	}
	if (!current.ribbons[location] || !baseline.ribbons[location]) throw new Error("The requested ribbon location is not loaded.");
	return entity;
}

function byIdUnique<T extends { id: string }>(values: T[], id: string, category: string): T | undefined {
	const candidates = values.filter(value => value.id === id);
	if (candidates.length > 1) throw new Error(`Ambiguous ${category} ${id} in loaded ribbon workspace.`);
	return candidates[0];
}

function findTab(ribbon: RibbonDefinition, id: string): RibbonTab | undefined {
	return byIdUnique(ribbon.tabs, id, "Tab");
}

function findGroup(ribbon: RibbonDefinition, id: string): { tab: RibbonTab; group: RibbonGroup } | undefined {
	const found = ribbon.tabs.flatMap(tab => tab.groups.filter(group => group.id === id).map(group => ({ tab, group })));
	if (found.length > 1) throw new Error(`Ambiguous group ${id} in selected ribbon scope.`);
	return found[0];
}

function findButton(ribbon: RibbonDefinition, id: string): { tab: RibbonTab; group: RibbonGroup; button: RibbonButton } | undefined {
	const found = ribbon.tabs.flatMap(tab => tab.groups.flatMap(group => group.buttons.filter(button => button.id === id).map(button => ({ tab, group, button }))));
	if (found.length > 1) throw new Error(`Ambiguous button ${id} in selected ribbon scope.`);
	return found[0];
}

function parseWrappedItem<T extends "Tab" | "Group" | "Control">(
	item: Element,
	kind: T,
	location: RibbonLocation,
	entity: string,
): T extends "Tab" ? RibbonTab : T extends "Group" ? RibbonGroup : RibbonButton {
	const doc = parseXmlStrict('<RibbonDefinitions><RibbonDefinition><Tabs><Tab Id="__import_tab"><Groups><Group Id="__import_group"><Controls/></Group></Groups></Tab></Tabs></RibbonDefinition></RibbonDefinitions>');
	const tab = doc.querySelector('Tab[Id="__import_tab"]')!;
	const group = doc.querySelector('Group[Id="__import_group"]')!;
	const controls = group.querySelector("Controls")!;
	if (kind === "Tab") tab.parentNode!.replaceChild(doc.importNode(item, true), tab);
	else if (kind === "Group") group.parentNode!.replaceChild(doc.importNode(item, true), group);
	else controls.appendChild(doc.importNode(item, true));
	const parsed = parseRibbonXml(serializeXml(doc), location, entity).ribbon.tabs[0];
	if (!parsed) throw new Error(`Unable to parse imported ${kind} ${requiredAttr(item, "Id")}.`);
	const result = kind === "Tab" ? parsed : kind === "Group" ? parsed.groups[0] : parsed.groups[0]?.buttons[0];
	if (!result) throw new Error(`Imported ${kind} ${requiredAttr(item, "Id")} could not be represented in the ribbon workspace.`);
	return result as T extends "Tab" ? RibbonTab : T extends "Group" ? RibbonGroup : RibbonButton;
}

function resolveButtonLabels(button: RibbonButton, element: Element, labels: LocLabel[]): void {
	button.label = resolveDisplayLabel(element.getAttribute("LabelText") ?? button.id, labels);
	button.tooltipTitle = element.hasAttribute("ToolTipTitle") ? resolveDisplayLabel(element.getAttribute("ToolTipTitle"), labels) : undefined;
	button.tooltipBody = element.hasAttribute("ToolTipDescription") ? resolveDisplayLabel(element.getAttribute("ToolTipDescription"), labels) : undefined;
}

function validateButtonReferences(buttons: RibbonButton[], next: RibbonWorkspace): void {
	for (const button of buttons) {
		if (!button.commandId) continue;
		if (!next.commands.some(cmd => cmd.id === button.commandId) && !/^(Mscrm|Microsoft)\./.test(button.commandId)) {
			throw new Error(`Button ${button.id} references undefined command ${button.commandId}. Import its definition or select a known command.`);
		}
	}
}

function assertLocLabelReferences(node: Element, labels: LocLabel[]): void {
	for (const element of [node, ...Array.from(node.querySelectorAll("*"))]) {
		for (const attribute of Array.from(element.attributes)) {
			const refs = attribute.value.matchAll(/\$LocLabels:([^\s"'&<>]+)/g);
			for (const [, id] of refs) {
				if (!labels.some(label => label.id === id)) {
					throw new Error(`Missing imported/localized label ${id} referenced by ${element.tagName}. Include its LocLabel definition.`);
				}
			}
		}
	}
}

function upsert<T extends { id: string }>(items: T[], incoming: T): void {
	const matches = items.map((value, index) => value.id === incoming.id ? index : -1).filter(index => index >= 0);
	if (matches.length > 1) throw new Error(`Ambiguous existing definition ${incoming.id}.`);
	if (matches.length === 1) items[matches[0]] = incoming;
	else items.push(incoming);
}

function applyCommandAndRules(next: RibbonWorkspace, imported: ReturnType<typeof parseRibbonXml>, root: Element): void {
	for (const command of imported.commands) upsert<CommandDefinition>(next.commands, command);
	for (const rule of imported.enableRules) upsert<EnableRule>(next.enableRules, rule);
	for (const rule of imported.displayRules) upsert<DisplayRule>(next.displayRules, rule);
	for (const label of imported.locLabels) upsert<LocLabel>(next.locLabels, label);
	const importedCommands = children(only(root, "CommandDefinitions") ?? root, "CommandDefinition");
	for (const definition of importedCommands) {
		const command = byIdUnique(next.commands, requiredAttr(definition, "Id"), "command")!;
		for (const id of command.enableRules) {
			if (!next.enableRules.some(rule => rule.id === id) && !/^(Mscrm|Microsoft)\./.test(id)) {
				throw new Error(`Command ${command.id} refers to missing enable rule ${id}.`);
			}
		}
		for (const id of command.displayRules) {
			if (!next.displayRules.some(rule => rule.id === id) && !/^(Mscrm|Microsoft)\./.test(id)) {
				throw new Error(`Command ${command.id} refers to missing display rule ${id}.`);
			}
		}
	}
}

function applyAction(ribbon: RibbonDefinition, action: Element, next: RibbonWorkspace, location: RibbonLocation, entity: string): void {
	const anchor = requiredAttr(action, "Location");
	const payload = children(only(action, "CommandUIDefinition")!)[0];
	const itemId = requiredAttr(payload, "Id");
	assertLocLabelReferences(payload, next.locLabels);

	if (payload.tagName === "Tab") {
		if (anchor === "Mscrm.Tabs._children") {
			if (findTab(ribbon, itemId)) throw new Error(`Tab ${itemId} already exists. Use a safe explicit override rather than adding it twice.`);
			if (payload.hasAttribute("Template")) {
				throw new Error(`New Tab ${itemId} has an unsupported Template attribute that the ribbon generator cannot preserve.`);
			}
			const tab = parseWrappedItem(payload, "Tab", location, entity);
			tab.label = resolveDisplayLabel(payload.getAttribute("Title") ?? payload.getAttribute("Label") ?? tab.id, next.locLabels);
			for (const group of tab.groups) {
				if (findGroup(ribbon, group.id)) throw new Error(`New Tab ${itemId} duplicates group ${group.id}.`);
				const raw = children(only(payload, "Groups")!).find(candidate => candidate.getAttribute("Id") === group.id);
				group.label = resolveDisplayLabel(raw?.getAttribute("Title") ?? raw?.getAttribute("Label") ?? group.id, next.locLabels);
			}
			if (!payload.hasAttribute("Sequence") && action.hasAttribute("Sequence")) tab.sequence = Number(action.getAttribute("Sequence"));
			ribbon.tabs.push(tab);
			ribbon.tabs.sort((a, b) => a.sequence - b.sequence);
			return;
		}
		const existing = findTab(ribbon, itemId);
		if (!existing || anchor !== itemId || children(payload).length) {
			throw new Error(`Cannot safely override Tab ${itemId}. Use Location="${itemId}" with a leaf declaration, or add a new tab at Mscrm.Tabs._children.`);
		}
		if (payload.hasAttribute("Title") || payload.hasAttribute("Label")) existing.label = resolveDisplayLabel(payload.getAttribute("Title") ?? payload.getAttribute("Label"), next.locLabels);
		if (payload.hasAttribute("Sequence")) existing.sequence = Number(payload.getAttribute("Sequence"));
		if (payload.hasAttribute("Template")) existing.template = payload.getAttribute("Template")!;
		if (payload.hasAttribute("Command")) existing.commandId = payload.getAttribute("Command")!;
		ribbon.tabs.sort((a, b) => a.sequence - b.sequence);
		return;
	}

	if (payload.tagName === "Group") {
		const parent = ribbon.tabs.find(tab => anchor === `${tab.id}.Groups._children`);
		if (parent) {
			if (findGroup(ribbon, itemId)) throw new Error(`Group ${itemId} already exists in this ribbon.`);
			const group = parseWrappedItem(payload, "Group", location, entity);
			group.label = resolveDisplayLabel(payload.getAttribute("Title") ?? payload.getAttribute("Label") ?? group.id, next.locLabels);
			if (!payload.hasAttribute("Sequence") && action.hasAttribute("Sequence")) group.sequence = Number(action.getAttribute("Sequence"));
			parent.groups.push(group);
			parent.groups.sort((a, b) => a.sequence - b.sequence);
			return;
		}
		const existing = findGroup(ribbon, itemId);
		if (!existing || anchor !== itemId || children(payload).some(element => element.tagName === "Controls" && children(element).length)) {
			throw new Error(`Cannot safely override Group ${itemId}: the target must uniquely match the existing group without replacing nested controls.`);
		}
		if (payload.hasAttribute("Title") || payload.hasAttribute("Label")) existing.group.label = resolveDisplayLabel(payload.getAttribute("Title") ?? payload.getAttribute("Label"), next.locLabels);
		if (payload.hasAttribute("Sequence")) existing.group.sequence = Number(payload.getAttribute("Sequence"));
		if (payload.hasAttribute("Template")) existing.group.template = payload.getAttribute("Template")!;
		existing.tab.groups.sort((a, b) => a.sequence - b.sequence);
		return;
	}

	const incoming = parseWrappedItem(payload, "Control", location, entity);
	resolveButtonLabels(incoming, payload, next.locLabels);
	if (!payload.hasAttribute("Sequence") && action.hasAttribute("Sequence")) incoming.sequence = Number(action.getAttribute("Sequence"));
	validateButtonReferences([incoming], next);
	const old = findButton(ribbon, itemId);
	const placement = ribbon.tabs.flatMap(tab => tab.groups.map(group => ({ tab, group })))
		.filter(({ group }) => `${group.id}.Controls._children` === anchor);
	if (placement.length > 1) throw new Error(`Location ${anchor} ambiguously matches multiple groups.`);
	if (placement.length === 0 && (!old || anchor !== itemId)) {
		throw new Error(`Unknown or out-of-scope CustomAction Location "${anchor}" for ${itemId}. Select a known group's Controls._children anchor.`);
	}
	if (old && old.button.kind !== incoming.kind) {
		throw new Error(`Changing control kind for ${itemId} is not representable without deleting the original action first.`);
	}

	if (old) {
		const target = placement[0]?.group ?? old.group;
		// Source raw XML may hold nested menus/vendor metadata that a standalone
		// control override does not reproduce. Keep the baseline subtree for a
		// simple attribute change; reject conflicting opaque nested structures.
		if (old.button.sourceXml) {
			const oldSource = parseXmlStrict(old.button.sourceXml).documentElement;
			for (const attribute of Array.from(payload.attributes)) {
				if (!MODELED_CONTROL_ATTRIBUTES.has(attribute.name) && oldSource.getAttribute(attribute.name) !== attribute.value) {
					throw new Error(`Unsupported new control extension attribute ${attribute.name} on ${itemId}: this editor cannot preserve it in an override.`);
				}
			}
			if (children(payload).length && serializeXmlChildren(oldSource) !== serializeXmlChildren(payload)) {
				throw new Error(`The nested XML of ${itemId} differs from its loaded source; edit it in a supported XML workflow before importing.`);
			}
		}
		const updated: RibbonButton = {
			...old.button,
			// Attribute overrides that omit an optional property must not silently
			// erase unrelated existing source fields.
			label: payload.hasAttribute("LabelText") ? incoming.label : old.button.label,
			commandId: payload.hasAttribute("Command") ? incoming.commandId : old.button.commandId,
			templateAlias: payload.hasAttribute("TemplateAlias") ? incoming.templateAlias : old.button.templateAlias,
			sequence: payload.hasAttribute("Sequence") || action.hasAttribute("Sequence") ? incoming.sequence : old.button.sequence,
			tooltipTitle: payload.hasAttribute("ToolTipTitle") ? incoming.tooltipTitle : old.button.tooltipTitle,
			tooltipBody: payload.hasAttribute("ToolTipDescription") ? incoming.tooltipBody : old.button.tooltipBody,
			icon: payload.hasAttribute("ModernImage") ? incoming.icon : old.button.icon,
			image16: payload.hasAttribute("Image16by16") ? incoming.image16 : old.button.image16,
			image32: payload.hasAttribute("Image32by32") ? incoming.image32 : old.button.image32,
			sourceXml: old.button.sourceXml ?? incoming.sourceXml,
			hidden: old.button.hidden,
			oob: old.button.oob,
			custom: old.button.custom,
			managed: old.button.managed,
			origin: old.button.origin,
		};
		if (target === old.group) old.group.buttons[old.group.buttons.indexOf(old.button)] = updated;
		else {
			old.group.buttons.splice(old.group.buttons.indexOf(old.button), 1);
			target.buttons.push(updated);
		}
		target.buttons.sort((a, b) => a.sequence - b.sequence);
	} else {
		if (!placement.length) throw new Error(`Cannot place new control ${itemId} at override-only Location ${anchor}.`);
		for (const other of Object.values(next.ribbons)) {
			if (other !== ribbon && findButton(other, itemId)) throw new Error(`Control ${itemId} is already declared in another ribbon scope.`);
		}
		incoming.hidden = false;
		incoming.oob = false;
		incoming.custom = true;
		incoming.managed = false;
		incoming.origin = "unmanaged";
		placement[0].group.buttons.push(incoming);
		placement[0].group.buttons.sort((a, b) => a.sequence - b.sequence);
	}
}

function serializeXmlChildren(element: Element): string {
	return children(element).map(serializeXml).join("");
}

function applyTabRulesAndScaling(ribbon: RibbonDefinition, root: Element, entity: string, location: RibbonLocation): void {
	const section = only(only(root, "RuleDefinitions") ?? root, "TabDisplayRules");
	if (section) {
		for (const rule of children(section)) {
			const tabCommand = requiredAttr(rule, "TabCommand");
			const matches = ribbon.tabs.filter(tab => tab.commandId === tabCommand);
			if (matches.length !== 1) throw new Error(`TabDisplayRule ${tabCommand} cannot uniquely identify a tab in the selected ribbon location.`);
			// Reuse the real parser, which binds TabCommand only to an actual Tab.
			const doc = parseXmlStrict('<RibbonDefinitions><RibbonDefinition><Tabs/></RibbonDefinition><RuleDefinitions><TabDisplayRules/></RuleDefinitions></RibbonDefinitions>');
			const holder = doc.querySelector("Tabs")!;
			const tabElement = doc.createElement("Tab");
			tabElement.setAttribute("Id", matches[0].id);
			tabElement.setAttribute("Command", tabCommand);
			holder.appendChild(tabElement);
			doc.querySelector("TabDisplayRules")!.appendChild(doc.importNode(rule, true));
			const parsed = parseRibbonXml(serializeXml(doc), location, entity);
			const parsedRule: TabDisplayRule | undefined = parsed.ribbon.tabs[0]?.tabDisplayRules[0];
			if (!parsedRule || parsedRule.rules.length !== children(only(rule, "DisplayRules")!).length) {
				throw new Error(`TabDisplayRule ${tabCommand} cannot be represented by the ribbon parser.`);
			}
			// xmlParser currently collects EntityRules before PageRules. Recover the
			// authored interleaving using each recognized kind's original DOM order.
			const byKind = new Map<string, TabDisplayRule["rules"]>();
			for (const item of parsedRule.rules) {
				const list = byKind.get(item.kind) ?? [];
				list.push(item);
				byKind.set(item.kind, list);
			}
			parsedRule.rules = children(only(rule, "DisplayRules")!).map(step => {
				const item = byKind.get(step.tagName)?.shift();
				if (!item) throw new Error(`TabDisplayRule ${tabCommand} contains a rule kind the parser cannot preserve.`);
				return item;
			});
			const previous = matches[0].tabDisplayRules.findIndex(entry => entry.tabCommand === tabCommand);
			if (previous >= 0) matches[0].tabDisplayRules[previous] = parsedRule;
			else matches[0].tabDisplayRules.push(parsedRule);
		}
	}
	const scalings = only(root, "Scalings");
	if (scalings) {
		const parsed = parseRibbonXml(serializeXml(root), location, entity).ribbon.scalingByTab ?? {};
		for (const scaling of children(scalings)) {
			const tabId = requiredAttr(scaling, "TabId");
			if (!findTab(ribbon, tabId) || !parsed[tabId]) throw new Error(`Scaling for unknown tab ${tabId} cannot be imported into ${location}.`);
			ribbon.scalingByTab ??= {};
			ribbon.scalingByTab[tabId] = parsed[tabId];
		}
	}
}

/**
 * Apply an authored RibbonDiffXml fragment entirely in memory. The caller must
 * commit this returned workspace as ONE undoable edit; a throw leaves both
 * workspaces untouched, including the immutable imported baseline/source.
 *
 * Replace resets the UNSAVED EDITOR draft to the loaded baseline first; it does
 * not mutate the exported unmanaged solution or anything on the server.
 */
export function applyImportedRibbonXml(
	current: RibbonWorkspace,
	baseline: RibbonWorkspace,
	xml: string,
	location: RibbonLocation,
	mode: "append" | "replace",
): RibbonWorkspace {
	if (mode !== "append" && mode !== "replace") throw new Error(`Unknown ribbon import mode ${String(mode)}.`);
	const entity = workspaceEntity(current, baseline, location);
	const doc = parseXmlStrict(xml, "RibbonDiffXml");
	const root = doc.documentElement;
	validateImport(root);
	const next: RibbonWorkspace = structuredClone(mode === "replace" ? baseline : current);
	const imported = parseRibbonXml(xml, location, entity);
	applyCommandAndRules(next, imported, root);
	const ribbon = next.ribbons[location];
	const actions = only(root, "CustomActions");
	const incoming = actions ? children(actions) : [];
	const seenControls = new Set<string>();
	const seenHides = new Set<string>();
	for (const action of incoming) {
		if (action.tagName === "CustomAction") {
			const payload = children(only(action, "CommandUIDefinition")!)[0];
			const id = requiredAttr(payload, "Id");
			if (seenControls.has(id)) throw new Error(`Duplicate imported control declaration ${id}.`);
			seenControls.add(id);
			applyAction(ribbon, action, next, location, entity);
		} else {
			const target = requiredAttr(action, "Location");
			if (seenHides.has(target)) throw new Error(`Duplicate hide declaration for ${target}.`);
			seenHides.add(target);
			const button = findButton(ribbon, target);
			if (!button) throw new Error(`HideCustomAction Location ${target} does not match a visible control in the selected scope.`);
			button.button.hidden = true;
		}
	}
	applyTabRulesAndScaling(ribbon, root, entity, location);
	for (const action of incoming) assertLocLabelReferences(action, next.locLabels);
	if (!next.commands.every(command => command.actions.every(action => action.kind === "javascript" || action.kind === "url" || action.kind === "powerFx" || action.kind === "customApi"))) {
		throw new Error("The imported command includes an unrepresentable action.");
	}
	const changed = JSON.stringify(next) !== JSON.stringify(mode === "replace" ? baseline : current);
	if (!changed) throw new Error("Imported XML contains no supported changes for the selected ribbon workspace.");
	return next;
}
