import { parseXmlStrict, serializeXml } from "@/services/ribbonMerge";
import { resolveDisplayLabel } from "@/utils/displayLabel";
import type { LocLabel } from "@/types/ribbon";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

function childElements(parent: ParentNode, tag: string): Element[] {
	return Array.from(parent.childNodes)
		.filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === tag);
}

/**
 * ExportSolution retains unmanaged LocLabels even when RetrieveEntityRibbon
 * returns zero LocLabel declarations. Read only the selected source's direct
 * LocLabels section: a nested extension must not impersonate a definition.
 */
function sourceLabels(xml: string, context: string): LocLabel[] {
	const doc = parseXmlStrict(xml, "RibbonDiffXml");
	const sections = childElements(doc.documentElement, "LocLabels");
	if (sections.length > 1) throw new Error(`Duplicate LocLabels sections in ${context} ribbon source.`);
	if (!sections.length) return [];

	const result: LocLabel[] = [];
	const known = new Set<string>();
	for (const label of childElements(sections[0], "LocLabel")) {
		const id = label.getAttribute("Id");
		if (!id?.trim()) throw new Error(`An exported ${context} LocLabel has no Id.`);
		if (known.has(id)) throw new Error(`Duplicate ${context} LocLabel ${id} in exported ribbon source.`);
		known.add(id);

		const titles: LocLabel["titles"] = [];
		const codes = new Set<number>();
		for (const titlesSection of childElements(label, "Titles")) {
			for (const title of childElements(titlesSection, "Title")) {
				const code = title.getAttribute("languagecode");
				const languageCode = Number(code);
				if (!code || !/^\d+$/.test(code) || !Number.isSafeInteger(languageCode) || languageCode <= 0 || codes.has(languageCode)) {
					throw new Error(`Invalid or duplicated language code in exported ${context} LocLabel ${id}.`);
				}
				codes.add(languageCode);
				titles.push({ languageCode, description: title.getAttribute("description") ?? "" });
			}
		}
		result.push({ id, titles, sourceXml: serializeXml(label) });
	}
	return result;
}

/**
 * Entity customizations have precedence over application customizations, which
 * have precedence over compiled ribbon definitions. A lower-precedence label
 * can contribute *missing* translations, but never replace an existing locale
 * or the higher-precedence original sourceXml subtree.
 */
function mergeLabels(entity: LocLabel[], application: LocLabel[], merged: LocLabel[]): LocLabel[] {
	const result: LocLabel[] = [];
	const byId = new Map<string, LocLabel>();
	for (const label of [...entity, ...application, ...merged]) {
		const existing = byId.get(label.id);
		if (!existing) {
			const newLabel: LocLabel = {
				...label,
				titles: label.titles.map(title => ({ ...title })),
			};
			byId.set(label.id, newLabel);
			result.push(newLabel);
			continue;
		}
		const languages = new Set(existing.titles.map(title => title.languageCode));
		for (const title of label.titles) {
			if (!languages.has(title.languageCode)) {
				existing.titles.push({ ...title });
				languages.add(title.languageCode);
			}
		}
	}
	return result;
}

/**
 * Prefer the actual raw label token, not the already-resolved canvas string.
 * The original parser retains each Tab/Group/Button subtree in sourceXml even
 * when compiled output has no backing <LocLabel> for a $LocLabels reference.
 */
function rawSourceElement(sourceXml: string | undefined, expectedTag: string): Element | null {
	return sourceXml ? parseXmlStrict(sourceXml, expectedTag).documentElement : null;
}

function displayAttribute(root: Element | null, attribute: string, labels: LocLabel[]): string | undefined {
	const token = root?.getAttribute(attribute);
	return token == null ? undefined : resolveDisplayLabel(token, labels);
}

/**
 * Pure, pre-baseline display hydration. Neither the merged ribbon's raw XML,
 * command/rule definitions, nor its source snapshot is rewritten or published.
 * The calling loader applies this *before* loadWorkspace captures its baseline.
 */
export function hydrateRibbonLabels(workspace: RibbonWorkspace, sourceSnapshot: RibbonSourceSnapshot | null): RibbonWorkspace {
	if (!sourceSnapshot) return workspace;
	const entity = sourceSnapshot.entityLogicalName;
	for (const location of ["HomepageGrid", "SubGrid", "Form"] as const) {
		if (workspace.ribbons[location]?.entityLogicalName !== entity) {
			throw new Error(`The ${location} workspace entity does not match the exported ribbon source for ${entity}.`);
		}
	}

	const entityLocLabels = sourceLabels(sourceSnapshot.entityRibbonXml, "entity");
	const applicationLocLabels = sourceSnapshot.applicationRibbonXml
		? sourceLabels(sourceSnapshot.applicationRibbonXml, "application")
		: [];
	if (!entityLocLabels.length && !applicationLocLabels.length) return workspace;

	const hydrated: RibbonWorkspace = structuredClone(workspace);
	const labels = mergeLabels(entityLocLabels, applicationLocLabels, hydrated.locLabels);
	hydrated.locLabels = labels;

	for (const ribbon of Object.values(hydrated.ribbons)) {
		for (const tab of ribbon.tabs) {
			const originalTab = rawSourceElement(tab.sourceXml, "Tab");
			tab.label = displayAttribute(originalTab, "Title", labels) ?? tab.label;
			for (const group of tab.groups) {
				const originalGroup = rawSourceElement(group.sourceXml, "Group");
				group.label = displayAttribute(originalGroup, "Title", labels)
					?? displayAttribute(originalGroup, "Label", labels)
					?? group.label;
				for (const button of group.buttons) {
					const tag = {
						button: "Button", flyout: "FlyoutAnchor", splitButton: "SplitButton", textBox: "TextBox",
						comboBox: "ComboBox", checkBox: "CheckBox",
					}[button.kind];
					if (!tag) continue;
					const originalControl = rawSourceElement(button.sourceXml, tag);
					button.label = displayAttribute(originalControl, "LabelText", labels) ?? button.label;
					button.tooltipTitle = displayAttribute(originalControl, "ToolTipTitle", labels) ?? button.tooltipTitle;
					button.tooltipBody = displayAttribute(originalControl, "ToolTipDescription", labels) ?? button.tooltipBody;
				}
			}
		}
	}
	return hydrated;
}
