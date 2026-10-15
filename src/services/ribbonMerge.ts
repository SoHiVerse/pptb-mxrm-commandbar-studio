import type { RibbonDelta } from "@/types/workspace";

const MAX_XML_CHARS = 20 * 1024 * 1024;
const CONTROL_TAGS = new Set([
	"Button", "FlyoutAnchor", "SplitButton", "TextBox", "ComboBox", "CheckBox",
]);
const KNOWN_ACTION_TAGS = new Set(["JavaScriptFunction", "Url"]);
const KNOWN_RULE_STEPS = new Set([
	"CommandClientTypeRule", "CrmClientTypeRule", "CrmOfflineAccessStateRule",
	"CrmOutlookClientTypeRule", "CrmOutlookClientVersionRule", "CustomRule", "DeviceTypeRule",
	"EntityPrivilegeRule", "EntityPropertyRule", "EntityRule", "FormEntityContextRule",
	"FormStateRule", "FormTypeRule", "HideForTabletExperienceRule", "MiscellaneousPrivilegeRule",
	"OptionSetRule", "OrganizationSettingRule", "OrRule", "OutlookItemTrackingRule",
	"OutlookRenderTypeRule", "OutlookVersionRule", "PageRule", "RecordPrivilegeRule",
	"ReferencingAttributeRequiredRule", "RelationshipTypeRule", "SelectionCountRule",
	"ShowOnGridAndQuickActionRule", "ShowOnGridRule", "ShowOnQuickActionRule", "SkuRule", "ValueRule",
]);

/** Parse conservatively: no DTD or entity declarations are allowed in an importable document. */
export function parseXmlStrict(xml: string, expectedRoot?: string): Document {
	if (typeof xml !== "string" || !xml.trim() || xml.length > MAX_XML_CHARS) {
		throw new Error("XML is empty or exceeds the XML size limit.");
	}
	if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
		throw new Error("XML DOCTYPE and entity declarations are prohibited.");
	}
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) {
		throw new Error(`XML parse error: ${doc.querySelector("parsererror")?.textContent ?? "invalid document"}`);
	}
	if (expectedRoot && doc.documentElement.tagName !== expectedRoot) {
		throw new Error(`Expected <${expectedRoot}> XML root; received <${doc.documentElement.tagName}>.`);
	}
	return doc;
}

/** Serialize without an XML declaration; callers embed RibbonDiffXml beneath another XML root. */
export function serializeXml(element: Node): string {
	return new XMLSerializer().serializeToString(element);
}

function children(parent: ParentNode, name?: string): Element[] {
	return Array.from(parent.childNodes)
		.filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE)
		.filter(node => name === undefined || node.tagName === name);
}

function child(parent: ParentNode, name: string): Element | undefined {
	const found = children(parent, name);
	if (found.length > 1) throw new Error(`Ambiguous duplicate <${name}> section.`);
	return found[0];
}

function ensureChild(parent: Element, name: string): Element {
	const existing = child(parent, name);
	if (existing) return existing;
	const added = parent.ownerDocument.createElement(name);
	parent.appendChild(added);
	return added;
}

function attr(element: Element, name: string): string {
	const value = element.getAttribute(name);
	if (!value?.trim()) throw new Error(`<${element.tagName}> requires ${name}.`);
	return value;
}

function scopedNodes(root: Element, path: string[]): Element[] {
	let context: Element[] = [root];
	for (const section of path) context = context.flatMap(parent => children(parent, section));
	return context;
}

function unique<T>(values: T[], description: string): void {
	const seen = new Set<T>();
	for (const value of values) {
		if (seen.has(value)) throw new Error(`Ambiguous duplicate ${description}: ${String(value)}`);
		seen.add(value);
	}
}

const DEFINITION_CONTAINERS: Array<{ path: string[]; tag: string; key: string }> = [
	{ path: ["CommandDefinitions"], tag: "CommandDefinition", key: "Id" },
	{ path: ["RuleDefinitions", "EnableRules"], tag: "EnableRule", key: "Id" },
	{ path: ["RuleDefinitions", "DisplayRules"], tag: "DisplayRule", key: "Id" },
	{ path: ["RuleDefinitions", "TabDisplayRules"], tag: "TabDisplayRule", key: "TabCommand" },
	{ path: ["LocLabels"], tag: "LocLabel", key: "Id" },
	{ path: ["Scalings"], tag: "Scaling", key: "TabId" },
];

function declarations(root: Element, path: string[], tag: string, key: string): Element[] {
	const sections = scopedNodes(root, path);
	if (sections.length > 1) throw new Error(`Ambiguous duplicate <${path.join("/")}> section.`);
	const found = sections.flatMap(section => children(section));
	for (const node of found) {
		if (node.tagName !== tag) {
			throw new Error(`Unsupported declaration <${node.tagName}> in ${path.join("/")}.`);
		}
	}
	unique(found.map(node => attr(node, key)), `${tag} ${key}`);
	return found;
}

function actionElements(root: Element): Element[] {
	const actionContainers = children(root, "CustomActions");
	if (actionContainers.length > 1) throw new Error("Ambiguous duplicate CustomActions section.");
	const nodes = actionContainers.flatMap(section => children(section));
	for (const node of nodes) {
		if (node.tagName !== "CustomAction" && node.tagName !== "HideCustomAction") {
			throw new Error(`Unsupported custom action <${node.tagName}>.`);
		}
	}
	unique(nodes.filter(node => node.tagName === "CustomAction").map(node => attr(node, "Id")), "CustomAction Id");
	unique(nodes.filter(node => node.tagName === "HideCustomAction").map(node => attr(node, "HideActionId")), "HideCustomAction Id");
	unique(nodes.filter(node => node.tagName === "HideCustomAction").map(node => attr(node, "Location")), "HideCustomAction Location");
	return nodes;
}

function nestedControls(root: Element, tagFilter?: Set<string>): Element[] {
	const actions = actionElements(root).filter(node => node.tagName === "CustomAction");
	return actions.flatMap(action => {
		const uid = child(action, "CommandUIDefinition");
		if (!uid) return [];
		return Array.from(uid.querySelectorAll("[Id]"))
			.filter(node => (tagFilter ?? CONTROL_TAGS).has(node.tagName));
	});
}

function verifyInput(root: Element): void {
	actionElements(root);
	const allControls = nestedControls(root);
	unique(allControls.map(node => attr(node, "Id")), "control Id");
	for (const definition of DEFINITION_CONTAINERS) {
		declarations(root, definition.path, definition.tag, definition.key);
	}
}

function cloneInto(target: Element, source: Element): Element {
	return target.ownerDocument.importNode(source, true) as Element;
}

function overlayAttributes(target: Element, incoming: Element, skip = new Set<string>()): void {
	for (const { name, value, namespaceURI } of Array.from(incoming.attributes)) {
		if (skip.has(name)) continue;
		if (namespaceURI) target.setAttributeNS(namespaceURI, name, value);
		else target.setAttribute(name, value);
	}
}

/** Update the edited node's known attributes while leaving unknown original nodes intact. */
function overlayElement(target: Element, incoming: Element): void {
	if (target.tagName !== incoming.tagName) {
		throw new Error(`Cannot replace ${target.tagName} with ${incoming.tagName} without losing unsupported XML.`);
	}
	if (CONTROL_TAGS.has(target.tagName)) {
		// The generator emits a complete edited control (retaining raw sourceXml
		// where available). Absence of one of these optional, supported attributes
		// therefore means an explicit clear. Other vendor attributes survive.
		for (const optional of [
			"Command", "ToolTipTitle", "ToolTipDescription", "ModernImage", "Image16by16", "Image32by32",
		]) {
			if (!incoming.hasAttribute(optional)) target.removeAttribute(optional);
		}
	}
	overlayAttributes(target, incoming);
	for (const item of children(incoming)) {
		const itemId = item.getAttribute("Id");
		let matching: Element | undefined;
		if (itemId) {
			const candidates = children(target).filter(node => node.tagName === item.tagName && node.getAttribute("Id") === itemId);
			if (candidates.length > 1) throw new Error(`Ambiguous nested declaration ${itemId}.`);
			matching = candidates[0];
		} else {
			const candidates = children(target, item.tagName);
			if (candidates.length === 1) matching = candidates[0];
		}
		if (matching) overlayElement(matching, item);
		else target.appendChild(cloneInto(target, item));
	}
}

function requireActionPayload(action: Element): Element {
	const uid = child(action, "CommandUIDefinition");
	if (!uid) throw new Error(`CustomAction ${attr(action, "Id")} lacks CommandUIDefinition.`);
	const payload = children(uid);
	if (payload.length !== 1 || ![
		...CONTROL_TAGS, "Tab", "Group",
	].includes(payload[0].tagName)) {
		throw new Error(`Unsupported CustomAction ${attr(action, "Id")} payload.`);
	}
	return payload[0];
}

function ownerAction(node: Element): Element {
	let ancestor: Node | null = node.parentNode;
	while (ancestor && ancestor.nodeType === Node.ELEMENT_NODE) {
		if ((ancestor as Element).tagName === "CustomAction") return ancestor as Element;
		ancestor = ancestor.parentNode;
	}
	throw new Error(`Declaration ${node.getAttribute("Id")} is outside CustomAction.`);
}

function removeNodePreservingSiblings(target: Element): void {
	const action = ownerAction(target);
	const uid = child(action, "CommandUIDefinition");
	let parent = target.parentNode;
	target.parentNode?.removeChild(target);
	// Prune empty structural shells after deleting the final nested tab/group.
	// Never delete unsupported vendor extensions or other meaningful siblings.
	const structuralContainers = new Set(["Ribbon", "Tabs", "Groups", "Controls"]);
	while (parent && parent !== uid && parent.nodeType === Node.ELEMENT_NODE &&
		structuralContainers.has((parent as Element).tagName) &&
		children(parent).length === 0 && !parent.textContent?.trim()) {
		const grandparent = parent.parentNode;
		grandparent?.removeChild(parent);
		parent = grandparent;
	}
	if (!uid || children(uid).length !== 0) return;
	const extra = children(action).filter(n => n !== uid);
	if (extra.length) throw new Error(`Cannot remove last control from action ${attr(action, "Id")}: unsupported sibling XML would be lost.`);
	action.parentNode?.removeChild(action);
}

function checkReferenced(root: Element, removal: { tag: string; id: string }): void {
	if (removal.tag === "CommandDefinition") {
		const users = root.querySelectorAll("[Command]");
		if (Array.from(users).some(node => node.getAttribute("Command") === removal.id)) {
			throw new Error(`Cannot remove command ${removal.id}: surviving XML references it.`);
		}
	} else if (removal.tag === "EnableRule" || removal.tag === "DisplayRule") {
		const containers = removal.tag === "EnableRule" ? ["CommandDefinitions > CommandDefinition > EnableRules"] :
			["CommandDefinitions > CommandDefinition > DisplayRules", "RuleDefinitions > TabDisplayRules"];
		if (containers.some(selector => Array.from(root.querySelectorAll(`${selector} ${removal.tag}[Id]`))
			.some(node => node.getAttribute("Id") === removal.id))) {
			throw new Error(`Cannot remove ${removal.tag} ${removal.id}: surviving XML references it.`);
		}
	} else if (removal.tag === "LocLabel") {
		if (Array.from(root.querySelectorAll("*")).some(node => Array.from(node.attributes)
			.some(a => a.value.includes(`$LocLabels:${removal.id}`)))) {
			throw new Error(`Cannot remove localized label ${removal.id}: surviving XML references it.`);
		}
	}
}

/** Explicitly removing a definition never deletes a surviving consumer's dependency. */
function removeDeclaration(root: Element, definition: typeof DEFINITION_CONTAINERS[number], id: string): void {
	const existing = declarations(root, definition.path, definition.tag, definition.key)
		.find(node => node.getAttribute(definition.key) === id);
	if (!existing) throw new Error(`Cannot remove missing ${definition.tag} ${id} from selected unmanaged layer.`);
	checkReferenced(root, { tag: definition.tag, id });
	existing.parentNode?.removeChild(existing);
}

function ensurePath(root: Element, path: string[]): Element {
	return path.reduce((parent, tag) => ensureChild(parent, tag), root);
}

/** A complete definition edit may remove/reorder supported nodes; opaque source
 * nodes must retain their exact place and meaning or the edit is refused. */
function requireUnknownChildrenPreserved(
	original: Element,
	incoming: Element | null | undefined,
	known: ReadonlySet<string>,
	context: string,
): void {
	const sourceChildren = children(original);
	const replacementChildren = incoming ? children(incoming) : [];
	for (const [index, existing] of sourceChildren.entries()) {
		if (known.has(existing.tagName)) continue;
		const candidate = replacementChildren[index];
		if (!candidate || canonicalizeXml(serializeXml(existing)) !== canonicalizeXml(serializeXml(candidate))) {
			throw new Error(`Unsupported original ${context} <${existing.tagName}> was not preserved in its original position.`);
		}
	}
	for (const [index, candidate] of replacementChildren.entries()) {
		if (known.has(candidate.tagName)) continue;
		const existing = sourceChildren[index];
		if (!existing || canonicalizeXml(serializeXml(existing)) !== canonicalizeXml(serializeXml(candidate))) {
			throw new Error(`Unsupported incoming ${context} <${candidate.tagName}> cannot be represented safely.`);
		}
	}
}

/** A generated definition is the complete edited subtree. Unknown source
 * extensions may pass through only when the generator retained them verbatim. */
function replaceDefinition(target: Element, incoming: Element): void {
	if (target.tagName !== incoming.tagName) throw new Error("Mismatched definition kinds.");
	if (target.tagName === "LocLabel") {
		requireUnknownChildrenPreserved(target, incoming, new Set(["Titles"]), "localized label extension");
		const oldTitles = child(target, "Titles");
		if (oldTitles) {
			requireUnknownChildrenPreserved(oldTitles, child(incoming, "Titles"), new Set(["Title"]), "localized title extension");
		}
	} else if (target.tagName === "CommandDefinition") {
		const allowed = new Set(["EnableRules", "DisplayRules", "Actions"]);
		requireUnknownChildrenPreserved(target, incoming, allowed, "command definition extension");
		const existingActions = child(target, "Actions");
		if (existingActions) {
			requireUnknownChildrenPreserved(existingActions, child(incoming, "Actions"), KNOWN_ACTION_TAGS, "command action");
		}
	} else if (target.tagName === "EnableRule" || target.tagName === "DisplayRule") {
		requireUnknownChildrenPreserved(target, incoming, KNOWN_RULE_STEPS, "rule step");
	} else if (target.tagName === "TabDisplayRule") {
		requireUnknownChildrenPreserved(target, incoming, new Set(["DisplayRules"]), "tab display rule");
	} else if (target.tagName === "Scaling") {
		requireUnknownChildrenPreserved(target, incoming, new Set(["MaxSize", "Scale"]), "scaling extension");
	}
	const destination = target.parentNode;
	if (!destination) throw new Error("Detached declaration.");
	const replacement = cloneInto(target, incoming);
	overlayAttributes(replacement, target, new Set(Array.from(incoming.attributes).map(a => a.name)));
	// Retain unknown (but inert) metadata attributes; the declaration body is intentionally complete.
	destination.replaceChild(replacement, target);
}

function upsertDeclaration(root: Element, definition: typeof DEFINITION_CONTAINERS[number], incoming: Element): void {
	const container = ensurePath(root, definition.path);
	const id = attr(incoming, definition.key);
	const existing = declarations(root, definition.path, definition.tag, definition.key)
		.find(node => node.getAttribute(definition.key) === id);
	if (existing) replaceDefinition(existing, incoming);
	else container.appendChild(cloneInto(container, incoming));
}

interface RemovedControl {
	node: Element;
	action: Element;
	directlyOwned: boolean;
}

type DeltaRemovalKey = Exclude<keyof RibbonDelta, "xml" | "elementPatches">;
type ElementPatch = NonNullable<RibbonDelta["elementPatches"]>[number];

function validateElementPatch(patch: ElementPatch): void {
	if (!patch || !["Tab", "Group"].includes(patch.kind) || !patch.id?.trim() ||
		!patch.attributes || typeof patch.attributes !== "object" || Array.isArray(patch.attributes)) {
		throw new Error("Invalid RibbonDelta.elementPatches entry.");
	}
	const supported = new Set(["Title", "Label", "Sequence", "Template", "Command"]);
	for (const [name, value] of Object.entries(patch.attributes)) {
		if (!supported.has(name)) throw new Error(`Unsupported element patch attribute ${name}; cannot modify identity or vendor metadata.`);
		if (value !== null && (typeof value !== "string" || value.length > 16384)) {
			throw new Error(`Invalid element patch ${name} value.`);
		}
		if (name === "Sequence" && (value === null || !/^(?:0|[1-9]\d{0,9})$/.test(value) || Number(value) > 2147483647)) {
			throw new Error(`Invalid element patch Sequence for ${patch.id}.`);
		}
	}
}

/** Merge additions/overrides into the original exported unmanaged RibbonDiffXml. */
export function mergeRibbonDiffXml(originalXml: string, deltas: RibbonDelta[]): string {
	const doc = parseXmlStrict(originalXml, "RibbonDiffXml");
	const root = doc.documentElement;
	verifyInput(root);

	const incomingRoots = deltas.map(delta => parseXmlStrict(delta.xml, "RibbonDiffXml").documentElement);
	const incomingActions: Element[] = [];
	const incomingDefinitions = DEFINITION_CONTAINERS.map(() => [] as Element[]);
	const incomingTemplates: Element[] = [];
	const elementPatches: ElementPatch[] = [];
	const removeSets: Record<DeltaRemovalKey, Set<string>> = {
		removedControlIds: new Set(), removedGroupIds: new Set(), removedTabIds: new Set(),
		unhiddenControlIds: new Set(), removedCommandIds: new Set(),
		removedEnableRuleIds: new Set(), removedDisplayRuleIds: new Set(),
		removedLocLabelIds: new Set(), removedTabDisplayRuleCommands: new Set(),
		removedScalingTabIds: new Set(),
	};
	for (let index = 0; index < deltas.length; index++) {
		const fragment = incomingRoots[index];
		const delta = deltas[index];
		for (const key of Object.keys(removeSets) as Array<keyof typeof removeSets>) {
			if (!Array.isArray(delta[key])) throw new Error(`RibbonDelta.${key} must be an array.`);
			for (const id of delta[key]) {
				if (!id || typeof id !== "string") throw new Error(`RibbonDelta.${key} contains an invalid ID.`);
				if (removeSets[key].has(id)) throw new Error(`Duplicate removal intent ${key}:${id} across deltas.`);
				removeSets[key].add(id);
			}
		}
		if (delta.elementPatches !== undefined) {
			if (!Array.isArray(delta.elementPatches) || delta.elementPatches.length > 1000) {
				throw new Error("RibbonDelta.elementPatches must be an array with at most 1000 entries.");
			}
			for (const patch of delta.elementPatches) {
				validateElementPatch(patch);
				elementPatches.push(patch);
			}
		}
		const allowedSections = new Set(["CustomActions", "CommandDefinitions", "RuleDefinitions", "LocLabels", "Scalings", "Templates"]);
		if (children(fragment).some(section => !allowedSections.has(section.tagName))) {
			throw new Error("Unsupported generated RibbonDiffXml section.");
		}
		incomingActions.push(...actionElements(fragment));
		DEFINITION_CONTAINERS.forEach((definition, i) => {
			incomingDefinitions[i].push(...declarations(fragment, definition.path, definition.tag, definition.key));
		});
		incomingTemplates.push(...scopedNodes(fragment, ["Templates", "RibbonTemplates"]));
	}

	unique(incomingActions.filter(a => a.tagName === "CustomAction").map(a => attr(a, "Id")), "incoming CustomAction Id across deltas");
	unique(incomingActions.filter(a => a.tagName === "HideCustomAction").map(a => attr(a, "HideActionId")), "incoming HideCustomAction Id across deltas");
	unique(incomingActions.filter(a => a.tagName === "HideCustomAction").map(a => attr(a, "Location")), "incoming HideCustomAction target across deltas");
	incomingDefinitions.forEach((nodes, i) => unique(nodes.map(node => attr(node, DEFINITION_CONTAINERS[i].key)), `${DEFINITION_CONTAINERS[i].tag} across deltas`));
	unique(incomingActions.filter(a => a.tagName === "CustomAction")
		.flatMap(a => Array.from(a.querySelectorAll("[Id]"))
			.filter(node => [...CONTROL_TAGS, "Group", "Tab"].includes(node.tagName))
			.map(node => attr(node, "Id"))), "incoming control/group/tab across deltas");
	unique(elementPatches.map(patch => `${patch.kind}\u0000${patch.id}`), "element patch across deltas");

	// Resolve patches against the original unmanaged layer, before any incoming
	// CustomActions are inserted. Never create a platform Tab/Group by guessing a
	// ribbon location or patch a newly generated and unverified declaration.
	const ownedPatches = elementPatches.map(patch => {
		const removalKey = patch.kind === "Tab" ? "removedTabIds" : "removedGroupIds";
		if (removeSets[removalKey].has(patch.id)) {
			throw new Error(`Ambiguous ${patch.kind} ${patch.id}: cannot patch an explicitly removed declaration.`);
		}
		if (incomingActions.some(action => action.tagName === "CustomAction" &&
			Array.from(action.querySelectorAll(patch.kind)).some(node => node.getAttribute("Id") === patch.id))) {
			throw new Error(`Ambiguous ${patch.kind} ${patch.id}: an incoming full declaration conflicts with an element patch.`);
		}
		const matches = nestedControls(root, new Set([patch.kind])).filter(node => node.getAttribute("Id") === patch.id);
		if (matches.length !== 1) {
			throw new Error(`${patch.kind} ${patch.id} is not uniquely owned by the selected unmanaged RibbonDiffXml (found ${matches.length}).`);
		}
		return { patch, target: matches[0], action: ownerAction(matches[0]) };
	});

	const namedRemoval: Array<[keyof typeof removeSets, typeof DEFINITION_CONTAINERS[number]]> = [
		["removedCommandIds", DEFINITION_CONTAINERS[0]],
		["removedTabDisplayRuleCommands", DEFINITION_CONTAINERS[3]],
		["removedEnableRuleIds", DEFINITION_CONTAINERS[1]],
		["removedDisplayRuleIds", DEFINITION_CONTAINERS[2]],
		["removedLocLabelIds", DEFINITION_CONTAINERS[4]],
		["removedScalingTabIds", DEFINITION_CONTAINERS[5]],
	];
	for (const [key, definition] of namedRemoval) {
		const readds = incomingDefinitions[DEFINITION_CONTAINERS.indexOf(definition)];
		for (const id of removeSets[key]) {
			if (readds.some(node => node.getAttribute(definition.key) === id)) {
				throw new Error(`Ambiguous removal and redeclaration of ${definition.tag} ${id}.`);
			}
		}
	}

	// Capture the source node before the explicit removal. An intentional move may reinsert it
	// elsewhere; its original unknown attributes/children survive that relocation.
	const removedControls = new Map<string, RemovedControl>();
	for (const [key, tags] of [
		["removedControlIds", CONTROL_TAGS],
		["removedGroupIds", new Set(["Group"])],
		["removedTabIds", new Set(["Tab"])],
	] as const) {
		for (const id of removeSets[key]) {
			const candidates = nestedControls(root, tags).filter(node => node.getAttribute("Id") === id);
			if (candidates.length !== 1) throw new Error(`Cannot remove ${key} ${id}: expected one original unmanaged declaration, found ${candidates.length}.`);
			const node = candidates[0];
			const action = ownerAction(node);
			const uid = child(action, "CommandUIDefinition");
			removedControls.set(id, { node: cloneInto(root, node), action: cloneInto(root, action), directlyOwned: node.parentNode === uid });
			removeNodePreservingSiblings(node);
		}
	}

	for (const id of removeSets.unhiddenControlIds) {
		const hides = actionElements(root).filter(node => node.tagName === "HideCustomAction" && node.getAttribute("Location") === id);
		if (hides.length !== 1) throw new Error(`Cannot unhide ${id}: no unique HideCustomAction exists in selected unmanaged layer.`);
		hides[0].parentNode?.removeChild(hides[0]);
	}

	for (const action of incomingActions) {
		const actionContainer = ensureChild(root, "CustomActions");
		const actionId = action.tagName === "CustomAction" ? attr(action, "Id") : attr(action, "HideActionId");
		const actionLocation = attr(action, "Location");
		if (action.tagName === "HideCustomAction") {
			if (removeSets.unhiddenControlIds.has(actionLocation)) throw new Error(`Conflicting hide and unhide ${actionLocation}.`);
			const existing = actionElements(root).filter(n => n.tagName === "HideCustomAction" && n.getAttribute("Location") === actionLocation);
			if (existing[0]) {
				overlayAttributes(existing[0], action, new Set(["HideActionId"]));
			} else {
				if (actionElements(root).some(n => n.tagName === "HideCustomAction" && n.getAttribute("HideActionId") === actionId)) {
					throw new Error(`HideCustomAction Id ${actionId} already belongs to another target.`);
				}
				actionContainer.appendChild(cloneInto(actionContainer, action));
			}
			continue;
		}

		const incomingPayload = requireActionPayload(action);
		const targetId = attr(incomingPayload, "Id");
		const priorMove = removedControls.get(targetId);
		if (priorMove && priorMove.node.tagName !== incomingPayload.tagName) {
			throw new Error(`Moving ${targetId} changes its control kind and would discard source XML.`);
		}
		const matching = nestedControls(root, new Set([incomingPayload.tagName]))
			.filter(control => control.getAttribute("Id") === targetId);
		const otherKind = nestedControls(root, new Set([...CONTROL_TAGS, "Group", "Tab"]))
			.filter(control => control.getAttribute("Id") === targetId);
		if (otherKind.length > 1 || (otherKind.length && matching.length === 0)) {
			throw new Error(`Ambiguous or unrepresentable control declaration ${targetId}.`);
		}
		if (matching.length === 1 && !priorMove) {
			const oldAction = ownerAction(matching[0]);
			const sourceLocation = attr(oldAction, "Location");
			if (actionLocation !== sourceLocation && actionLocation !== targetId) {
				throw new Error(`Moving ${targetId} to ${actionLocation} requires explicit removedControlIds/removedGroupIds/removedTabIds intent.`);
			}
			overlayElement(matching[0], incomingPayload);
			if (matching[0].parentNode === child(oldAction, "CommandUIDefinition")) {
				const sequence = action.getAttribute("Sequence");
				if (sequence) oldAction.setAttribute("Sequence", sequence);
			}
			continue;
		}

		if (actionElements(root).some(existing => existing.tagName === "CustomAction" && existing.getAttribute("Id") === actionId)) {
			throw new Error(`CustomAction ${actionId} exists with a different declaration; refusing ambiguous replacement.`);
		}
		let insertion = cloneInto(actionContainer, action);
		if (priorMove) {
			if (priorMove.directlyOwned && !actionElements(root).some(existing => existing.getAttribute("Id") === priorMove.action.getAttribute("Id"))) {
				// The old action had only this declaration, so preserve its original, possibly nonstandard Id.
				insertion = cloneInto(actionContainer, priorMove.action);
				overlayAttributes(insertion, action, new Set(["Id"]));
			}
			const uid = child(insertion, "CommandUIDefinition");
			if (!uid) throw new Error(`Missing moved action payload for ${targetId}.`);
			for (const node of children(uid)) uid.removeChild(node);
			const moved = cloneInto(uid, priorMove.node);
			overlayElement(moved, incomingPayload);
			uid.appendChild(moved);
		}
		actionContainer.appendChild(insertion);
	}

	for (const [index, definition] of DEFINITION_CONTAINERS.entries()) {
		for (const incoming of incomingDefinitions[index]) upsertDeclaration(root, definition, incoming);
	}
	for (const template of incomingTemplates) {
		const section = ensureChild(root, "Templates");
		const id = attr(template, "Id");
		const existing = children(section, "RibbonTemplates").filter(node => node.getAttribute("Id") === id);
		if (!existing.length) section.appendChild(cloneInto(section, template));
		else if (existing.length !== 1) throw new Error(`Duplicate template ${id}.`);
	}

	for (const [key, definition] of namedRemoval) {
		for (const id of removeSets[key]) removeDeclaration(root, definition, id);
	}

	for (const { patch, target, action } of ownedPatches) {
		if (!root.contains(target)) {
			throw new Error(`Element patch target ${patch.kind} ${patch.id} was removed while merging; refusing an ambiguous patch.`);
		}
		for (const [name, value] of Object.entries(patch.attributes)) {
			if (value === null) target.removeAttribute(name);
			else target.setAttribute(name, value);
			if (name === "Sequence" && target.parentNode === child(action, "CommandUIDefinition")) {
				// The authored root of a CustomAction has its own sequence as well as
				// the child element. A nested Group must not affect the enclosing tab.
				if (value === null) action.removeAttribute("Sequence");
				else action.setAttribute("Sequence", value);
			}
		}
	}

	verifyInput(root);
	return serializeXml(root);
}

/** Normalize insignificant XML-only indentation and attribute order, without sorting child nodes. */
export function canonicalizeXml(xml: string): string {
	const doc = parseXmlStrict(xml);
	const normalized = (node: Node): string => {
		switch (node.nodeType) {
			case Node.ELEMENT_NODE: {
				const element = node as Element;
				const attrs = Array.from(element.attributes)
					.sort((a, b) => a.name.localeCompare(b.name))
					.map(attribute => `${attribute.name}=${JSON.stringify(attribute.value)}`).join(" ");
				const nodes = Array.from(element.childNodes);
				const hasElements = nodes.some(item => item.nodeType === Node.ELEMENT_NODE);
				const body = nodes
					.filter(item => !(hasElements && item.nodeType === Node.TEXT_NODE && !item.textContent?.trim()))
					.map(normalized).join("");
				return `<${element.tagName}${attrs ? ` ${attrs}` : ""}>${body}</${element.tagName}>`;
			}
			case Node.TEXT_NODE:
			case Node.CDATA_SECTION_NODE:
				return JSON.stringify(node.textContent ?? "");
			case Node.COMMENT_NODE:
				return `<!--${node.textContent}-->`;
			case Node.PROCESSING_INSTRUCTION_NODE:
				return `<?${node.nodeName} ${node.textContent}?>`;
			default:
				return "";
		}
	};
	return normalized(doc.documentElement);
}
