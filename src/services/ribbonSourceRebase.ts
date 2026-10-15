import { canonicalizeXml, parseXmlStrict } from "@/services/ribbonMerge";
import { parseRibbonXml } from "@/services/xmlParser";
import type {
	CommandDefinition,
	DisplayRule,
	EnableRule,
	LocLabel,
	RibbonDefinition,
	RibbonLocation,
} from "@/types/ribbon";
import type { RibbonWorkspace } from "@/types/workspace";

/**
 * The verified compiled ribbon is authoritative for `sourceXml` snapshots.
 * The editable model remains authoritative for labels, command actions, rules,
 * ordering and other authored values. A cache rebase must never erase edits.
 */
const CONTROL_TAGS = new Set(["Button", "FlyoutAnchor", "SplitButton", "TextBox", "ComboBox", "CheckBox"]);
type ScopedKind = "tabs" | "groups" | "controls" | "commands" | "enableRules" | "displayRules" | "locLabels" | "tabDisplayRules" | "scalings";

type ScopedIndex = {
	readonly main: Record<ScopedKind, Map<string, Element>>;
	readonly actionFallback: Pick<Record<ScopedKind, Map<string, Element[]>>, "tabs" | "groups" | "controls">;
	pick(kind: ScopedKind, id: string): Element | undefined;
};

interface ScopeReferences {
	commands: Set<string>;
	enableRules: Set<string>;
	displayRules: Set<string>;
	locLabels: Set<string>;
}

const toXml = (element: Element): string => new XMLSerializer().serializeToString(element);

function createIndex(xml: string, label: string): ScopedIndex {
	const document = parseXmlStrict(xml);
	const root = document.documentElement;
	if (root.tagName !== "RibbonDefinitions" && root.tagName !== "Ribbon") {
		throw new Error(`${label} must contain full compiled RibbonDefinitions XML; an unmanaged RibbonDiffXml fragment cannot rebase source caches.`);
	}
	const main = {
		tabs: new Map<string, Element>(),
		groups: new Map<string, Element>(),
		controls: new Map<string, Element>(),
		commands: new Map<string, Element>(),
		enableRules: new Map<string, Element>(),
		displayRules: new Map<string, Element>(),
		locLabels: new Map<string, Element>(),
		tabDisplayRules: new Map<string, Element>(),
		scalings: new Map<string, Element>(),
	} satisfies Record<ScopedKind, Map<string, Element>>;
	const actionFallback = {
		tabs: new Map<string, Element[]>(),
		groups: new Map<string, Element[]>(),
		controls: new Map<string, Element[]>(),
	};
	// RetrieveEntityRibbon(All) can legitimately repeat identical platform
	// commands. Differing duplicates are ambiguous only if this workspace
	// actually requests their ID; unrelated conflicts must not block a publish.
	const ambiguous = new Map<ScopedKind, Set<string>>();

	const assign = (kind: ScopedKind, id: string | null, element: Element): void => {
		if (!id) return;
		const existing = main[kind].get(id);
		if (existing) {
			if (canonicalizeXml(toXml(existing)) !== canonicalizeXml(toXml(element))) {
				const ids = ambiguous.get(kind) ?? new Set<string>();
				ids.add(id);
				ambiguous.set(kind, ids);
			}
			return;
		}
		main[kind].set(id, element);
	};
	const outsideActions = (element: Element): boolean => !element.closest("CustomAction, CommandUIDefinition");
	const outsideMenus = (element: Element): boolean => !element.parentElement?.closest("Menu, MenuSection, FlyoutAnchor, SplitButton");

	for (const element of Array.from(root.querySelectorAll("Tabs > Tab"))) {
		if (outsideActions(element)) assign("tabs", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("Groups > Group"))) {
		if (outsideActions(element) && outsideMenus(element)) assign("groups", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("Controls > *"))) {
		if (CONTROL_TAGS.has(element.tagName) && outsideActions(element) && outsideMenus(element) &&
			element.parentElement?.parentElement?.tagName === "Group") {
			assign("controls", element.getAttribute("Id"), element);
		}
	}

	// A full compiled document may contain both an effective Ribbon tree and
	// original CustomAction declarations. Prefer the effective control; do not
	// mistake its action reference for a second displayed control.
	for (const uid of Array.from(root.querySelectorAll("CustomAction > CommandUIDefinition"))) {
		for (const element of Array.from(uid.querySelectorAll("[Id]"))) {
			const kind: keyof typeof actionFallback | null = element.tagName === "Tab"
				? "tabs" : element.tagName === "Group"
					? "groups" : CONTROL_TAGS.has(element.tagName) && outsideMenus(element)
						? "controls" : null;
			const id = element.getAttribute("Id");
			if (!kind || !id) continue;
			const matches = actionFallback[kind].get(id) ?? [];
			matches.push(element);
			actionFallback[kind].set(id, matches);
		}
	}

	for (const element of Array.from(root.querySelectorAll("CommandDefinitions > CommandDefinition"))) {
		if (outsideActions(element)) assign("commands", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("RuleDefinitions > EnableRules > EnableRule"))) {
		if (outsideActions(element)) assign("enableRules", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("RuleDefinitions > DisplayRules > DisplayRule"))) {
		if (outsideActions(element)) assign("displayRules", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("RuleDefinitions > TabDisplayRules > TabDisplayRule"))) {
		if (outsideActions(element)) assign("tabDisplayRules", element.getAttribute("TabCommand"), element);
	}
	for (const element of Array.from(root.querySelectorAll("LocLabels > LocLabel"))) {
		if (outsideActions(element)) assign("locLabels", element.getAttribute("Id"), element);
	}
	for (const element of Array.from(root.querySelectorAll("Scalings > Scaling, Tab > Scaling"))) {
		if (!outsideActions(element)) continue;
		const id = element.getAttribute("TabId") ?? element.closest("Tab")?.getAttribute("Id") ?? null;
		if (!id) continue;
		// A complete top-level Scaling definition overrides a nested tab marker.
		if (main.scalings.has(id) && element.parentElement?.tagName === "Scalings") {
			main.scalings.set(id, element);
		} else if (!main.scalings.has(id)) {
			main.scalings.set(id, element);
		}
	}

	return {
		main,
		actionFallback,
		pick(kind, id) {
			if (ambiguous.get(kind)?.has(id)) throw new Error(`Ambiguous conflicting compiled ${kind} identity ${id} in ${label}.`);
			const effective = main[kind].get(id);
			if (effective) return effective;
			if (kind !== "tabs" && kind !== "groups" && kind !== "controls") return undefined;
			const candidates = actionFallback[kind].get(id) ?? [];
			if (candidates.length > 1) throw new Error(`Ambiguous duplicate compiled ${kind} identity ${id} in ${label}.`);
			return candidates[0];
		},
	};
}

function emptyReferences(): ScopeReferences {
	return {
		commands: new Set(),
		enableRules: new Set(),
		displayRules: new Set(),
		locLabels: new Set(),
	};
}

/** Only modeled title/control references justify introducing a new LocLabel. */
function collectLabelReferences(element: Element | undefined, references: Set<string>, nested: boolean): void {
	if (!element) return;
	const elements = nested ? [element, ...Array.from(element.querySelectorAll("*"))] : [element];
	for (const candidate of elements) {
		for (const attribute of Array.from(candidate.attributes)) {
			for (const matched of attribute.value.matchAll(/\$LocLabels:([^\s"'&<>]+)/g)) references.add(matched[1]);
		}
	}
}

function rebaseRibbon(ribbon: RibbonDefinition, index: ScopedIndex, references: ScopeReferences): void {
	for (const tab of ribbon.tabs) {
		const tabXml = index.pick("tabs", tab.id);
		if (tabXml) tab.sourceXml = toXml(tabXml);
		collectLabelReferences(tabXml, references.locLabels, false);
		if (tab.commandId) references.commands.add(tab.commandId);
		for (const tabRule of tab.tabDisplayRules) {
			const ruleXml = index.pick("tabDisplayRules", tabRule.tabCommand);
			if (ruleXml) tabRule.sourceXml = toXml(ruleXml);
		}
		for (const group of tab.groups) {
			const groupXml = index.pick("groups", group.id);
			if (groupXml) group.sourceXml = toXml(groupXml);
			collectLabelReferences(groupXml, references.locLabels, false);
			for (const button of group.buttons) {
				const buttonXml = index.pick("controls", button.id);
				if (buttonXml) button.sourceXml = toXml(buttonXml);
				// Preserve backing label definitions even for nested flyout menus
				// whose children are intentionally absent from the editable model.
				collectLabelReferences(buttonXml, references.locLabels, true);
				if (button.commandId) references.commands.add(button.commandId);
			}
		}
	}
	for (const [tabId, scaling] of Object.entries(ribbon.scalingByTab ?? {})) {
		const scalingXml = index.pick("scalings", tabId);
		if (scalingXml) scaling.sourceXml = toXml(scalingXml);
	}
}

function collectRuleReferences(references: ScopeReferences, commands: CommandDefinition[]): void {
	for (const command of commands) {
		if (!references.commands.has(command.id)) continue;
		command.enableRules.forEach((id) => references.enableRules.add(id));
		command.displayRules.forEach((id) => references.displayRules.add(id));
	}
}

/** A shared command/rule/label may have two legitimate compiled variants.
 * Keep the loader's entity-first precedence when it was not intentionally
 * edited; fail closed if the authored model differs from its previous cache. */
function isEditedSinceCachedSource(
	kind: "commands" | "enableRules" | "displayRules" | "locLabels",
	item: CommandDefinition | EnableRule | DisplayRule | LocLabel | undefined,
): boolean {
	if (!item?.sourceXml) return true;
	const wrappers = {
		commands: ["<CommandDefinitions>", "</CommandDefinitions>"],
		enableRules: ["<RuleDefinitions><EnableRules>", "</EnableRules></RuleDefinitions>"],
		displayRules: ["<RuleDefinitions><DisplayRules>", "</DisplayRules></RuleDefinitions>"],
		locLabels: ["<LocLabels>", "</LocLabels>"],
	} as const;
	const [before, after] = wrappers[kind];
	try {
		const parsed = parseRibbonXml(`<RibbonDefinitions>${before}${item.sourceXml}${after}</RibbonDefinitions>`, "HomepageGrid", "account");
		if (kind === "commands") {
			const actual = parsed.commands.find((command) => command.id === item.id);
			const edited = item as CommandDefinition;
			return !actual || JSON.stringify({ actions: actual.actions, enableRules: actual.enableRules, displayRules: actual.displayRules }) !==
				JSON.stringify({ actions: edited.actions, enableRules: edited.enableRules, displayRules: edited.displayRules });
		}
		if (kind === "enableRules" || kind === "displayRules") {
			const actual = parsed[kind].find((rule) => rule.id === item.id);
			return !actual || JSON.stringify(actual.steps) !== JSON.stringify((item as EnableRule | DisplayRule).steps);
		}
		const actual = parsed.locLabels.find((label) => label.id === item.id);
		return !actual || JSON.stringify(actual.titles) !== JSON.stringify((item as LocLabel).titles);
	} catch {
		return true;
	}
}

function compiledForId(
	kind: "commands" | "enableRules" | "displayRules" | "locLabels",
	id: string,
	entity: ScopedIndex,
	application: ScopedIndex | undefined,
	entityReferences: ScopeReferences,
	applicationReferences: ScopeReferences,
	item?: CommandDefinition | EnableRule | DisplayRule | LocLabel,
): Element | undefined {
	const entityElement = entityReferences[kind].has(id) ? entity.pick(kind, id) : undefined;
	const appElement = application && applicationReferences[kind].has(id) ? application.pick(kind, id) : undefined;
	if (entityElement && appElement && canonicalizeXml(toXml(entityElement)) !== canonicalizeXml(toXml(appElement)) &&
		isEditedSinceCachedSource(kind, item)) {
		throw new Error(`Conflicting verified entity/application ${kind} definition ${id}; a shared editable definition cannot hold different source caches.`);
	}
	// ribbonService's existing workspace deduplication keeps the entity-first
	// definition for shared IDs. Retain that precedence for unchanged variants.
	return entityElement ?? appElement;
}

function titlesFromCompiled(element: Element, id: string): LocLabel["titles"] {
	const titles: LocLabel["titles"] = [];
	const languageCodes = new Set<number>();
	for (const title of Array.from(element.querySelectorAll(":scope > Titles > Title"))) {
		const languageCode = Number(title.getAttribute("languagecode"));
		if (!Number.isInteger(languageCode) || languageCode <= 0 || languageCodes.has(languageCode)) {
			throw new Error(`Invalid or duplicate language code in verified LocLabel ${id}.`);
		}
		languageCodes.add(languageCode);
		titles.push({ languageCode, description: title.getAttribute("description") ?? "" });
	}
	if (!titles.length) throw new Error(`Verified LocLabel ${id} has no Titles; refusing incomplete source cache.`);
	return titles;
}

/**
 * Rebase raw XML caches from full, independently verified compiled ribbon XML.
 * Calling this on a later-edited current workspace preserves all newer model
 * values; only sourceXml and missing referenced label definitions are updated.
 * Application cache remains untouched when application XML is not supplied.
 */
export function rebaseWorkspaceSource(
	workspace: RibbonWorkspace,
	verifiedEntityXml: string,
	verifiedApplicationXml?: string,
): RibbonWorkspace {
	const entityIndex = createIndex(verifiedEntityXml, "Verified entity ribbon");
	const applicationIndex = verifiedApplicationXml === undefined
		? undefined : createIndex(verifiedApplicationXml, "Verified application ribbon");
	const rebased = JSON.parse(JSON.stringify(workspace)) as RibbonWorkspace;
	const entityReferences = emptyReferences();
	const applicationReferences = emptyReferences();

	for (const location of ["HomepageGrid", "SubGrid", "Form"] as const satisfies readonly RibbonLocation[]) {
		rebaseRibbon(rebased.ribbons[location], entityIndex, entityReferences);
	}
	if (applicationIndex) rebaseRibbon(rebased.ribbons.Application, applicationIndex, applicationReferences);
	collectRuleReferences(entityReferences, rebased.commands);
	collectRuleReferences(applicationReferences, rebased.commands);

	const rebaseDefinition = <T extends EnableRule | DisplayRule | CommandDefinition | LocLabel>(
		items: T[], kind: "commands" | "enableRules" | "displayRules" | "locLabels",
	): void => {
		for (const item of items) {
			const verified = compiledForId(kind, item.id, entityIndex, applicationIndex, entityReferences, applicationReferences, item);
			if (verified) item.sourceXml = toXml(verified);
		}
	};
	// Never reparse modeled actions/rules/labels into the user's model: they
	// may already contain later edits made while the first publish was running.
	rebaseDefinition(rebased.commands, "commands");
	rebaseDefinition(rebased.enableRules, "enableRules");
	rebaseDefinition(rebased.displayRules, "displayRules");
	rebaseDefinition(rebased.locLabels, "locLabels");

	const knownLabels = new Set(rebased.locLabels.map((label) => label.id));
	const candidates = new Set([
		...entityReferences.locLabels,
		...(applicationIndex ? applicationReferences.locLabels : []),
	]);
	for (const id of [...candidates].sort()) {
		if (knownLabels.has(id)) continue;
		const verified = compiledForId("locLabels", id, entityIndex, applicationIndex, entityReferences, applicationReferences);
		if (!verified) continue;
		rebased.locLabels.push({ id, titles: titlesFromCompiled(verified, id), sourceXml: toXml(verified) });
		knownLabels.add(id);
	}
	return rebased;
}

type CachedItem = { sourceXml?: string };

function uniqueCached<T extends CachedItem>(
	items: T[],
	key: (item: T) => string,
	label: string,
): Map<string, T> {
	const result = new Map<string, T>();
	for (const item of items) {
		const id = key(item);
		if (result.has(id)) throw new Error(`Ambiguous ${label} identity ${id} while transferring verified source caches.`);
		result.set(id, item);
	}
	return result;
}

function transferCaches<T extends CachedItem>(
	current: T[],
	before: T[],
	publishedRebased: T[],
	key: (item: T) => string,
	label: string,
): void {
	const beforeById = uniqueCached(before, key, `${label} before publication`);
	const publishedById = uniqueCached(publishedRebased, key, `${label} after publication`);
	uniqueCached(current, key, `current ${label}`);
	for (const item of current) {
		const id = key(item);
		const original = beforeById.get(id);
		const rebased = publishedById.get(id);
		if (!original || !rebased || rebased.sourceXml === undefined) continue;
		// A later edit or independent rebase may have supplied its own source
		// cache. Never replace metadata that diverged after publish started.
		if (item.sourceXml === original.sourceXml) item.sourceXml = rebased.sourceXml;
	}
}

/**
 * Transfer verified cache metadata onto the live workspace when the user may
 * have edited it after publication started. `publishedBeforeRebase` is exactly
 * the input snapshot captured for that publish, and `publishedRebased` is its
 * verified-cache result. All three must already belong to the same selected
 * organization/solution/entity; the caller enforces source identity and
 * generation guards because RibbonWorkspace deliberately has no such fields.
 *
 * Model values in `current` always win. A cache is updated only when that
 * item's previous sourceXml still equals the publish-start snapshot. Newly
 * generated label definitions may be adopted, but labels explicitly deleted
 * since capture are never resurrected.
 */
export function rebasePendingWorkspace(
	current: RibbonWorkspace,
	publishedBeforeRebase: RibbonWorkspace,
	publishedRebased: RibbonWorkspace,
): RibbonWorkspace {
	const next = JSON.parse(JSON.stringify(current)) as RibbonWorkspace;
	for (const location of ["HomepageGrid", "SubGrid", "Form", "Application"] as const satisfies readonly RibbonLocation[]) {
		const latestRibbon = next.ribbons[location];
		const beforeRibbon = publishedBeforeRebase.ribbons[location];
		const rebasedRibbon = publishedRebased.ribbons[location];
		if (!latestRibbon || !beforeRibbon || !rebasedRibbon ||
			latestRibbon.location !== beforeRibbon.location || latestRibbon.location !== rebasedRibbon.location ||
			latestRibbon.entityLogicalName !== beforeRibbon.entityLogicalName || latestRibbon.entityLogicalName !== rebasedRibbon.entityLogicalName) {
			throw new Error(`Ribbon workspace entity/location mismatch for ${location}; refusing stale cache transfer.`);
		}
		transferCaches(latestRibbon.tabs, beforeRibbon.tabs, rebasedRibbon.tabs, (tab) => tab.id, `${location} tab`);
		const allGroups = (ribbon: RibbonDefinition) => ribbon.tabs.flatMap((tab) => tab.groups);
		transferCaches(allGroups(latestRibbon), allGroups(beforeRibbon), allGroups(rebasedRibbon), (group) => group.id, `${location} group`);
		const allControls = (ribbon: RibbonDefinition) => allGroups(ribbon).flatMap((group) => group.buttons);
		transferCaches(allControls(latestRibbon), allControls(beforeRibbon), allControls(rebasedRibbon), (button) => button.id, `${location} control`);
		const tabRules = (ribbon: RibbonDefinition) => ribbon.tabs.flatMap((tab) => tab.tabDisplayRules);
		transferCaches(tabRules(latestRibbon), tabRules(beforeRibbon), tabRules(rebasedRibbon), (rule) => rule.tabCommand, `${location} tab display rule`);
		const scaling = (ribbon: RibbonDefinition) => Object.values(ribbon.scalingByTab ?? {});
		transferCaches(scaling(latestRibbon), scaling(beforeRibbon), scaling(rebasedRibbon), (entry) => entry.tabId, `${location} scaling`);
	}
	transferCaches(next.commands, publishedBeforeRebase.commands, publishedRebased.commands, (command) => command.id, "command");
	transferCaches(next.enableRules, publishedBeforeRebase.enableRules, publishedRebased.enableRules, (rule) => rule.id, "enable rule");
	transferCaches(next.displayRules, publishedBeforeRebase.displayRules, publishedRebased.displayRules, (rule) => rule.id, "display rule");
	transferCaches(next.locLabels, publishedBeforeRebase.locLabels, publishedRebased.locLabels, (label) => label.id, "localized label");

	const previouslyPresent = new Set(publishedBeforeRebase.locLabels.map((label) => label.id));
	const currentlyPresent = new Set(next.locLabels.map((label) => label.id));
	for (const label of publishedRebased.locLabels) {
		if (previouslyPresent.has(label.id) || currentlyPresent.has(label.id)) continue;
		next.locLabels.push(JSON.parse(JSON.stringify(label)) as LocLabel);
		currentlyPresent.add(label.id);
	}
	return next;
}
