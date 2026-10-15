import type {
	RibbonDefinition,
	RibbonLocation,
	CommandDefinition,
	EnableRule,
	DisplayRule,
	LocLabel,
	RibbonButton,
	RuleStep,
	ActionParameter,
	ScalingDefinition,
	RibbonGroup,
	RibbonTab,
} from "@/types/ribbon";
import {
	buttonLabelId,
	buttonTooltipTitleId,
	buttonTooltipBodyId,
	locLabelRef,
} from "@/utils/locLabelRef";
import type { RibbonDefinitions, RibbonDelta } from "@/types/workspace";

export interface GeneratorInput {
	current: RibbonDefinition;
	baseline: RibbonDefinition;
	commands: CommandDefinition[];
	enableRules: EnableRule[];
	displayRules: DisplayRule[];
	locLabels: LocLabel[];
	entityLogicalName: string;
	location: RibbonLocation;
	/** Immutable definitions captured with the loaded ribbon; required for definition-only changes. */
	baselineDefinitions?: RibbonDefinitions;
	/** Optional grouped definitions for callers that already own a RibbonDefinitions object. */
	definitions?: RibbonDefinitions;
}

type ControlPlacement = { button: RibbonButton; groupId: string; index: number };
type ControlOccurrence = ControlPlacement & { tabId: string; ordinal: number; key: string };

function sameModel(a: unknown, b: unknown): boolean {
	// `sourceXml` records the original XML, not an editable property. It must
	// not make a freshly parsed but otherwise unchanged definition look dirty.
	const withoutSource = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(withoutSource);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sourceXml").map(([key, v]) => [key, withoutSource(v)]));
		}
		return value;
	};
	return JSON.stringify(withoutSource(a)) === JSON.stringify(withoutSource(b));
}

function byIdUnique<T>(items: T[], id: (item: T) => string, label: string): Map<string, T> {
	const result = new Map<string, T>();
	for (const item of items) {
		const key = id(item);
		if (result.has(key)) throw new Error(`Ambiguous duplicate ${label} id "${key}"; ribbon import aborted.`);
		result.set(key, item);
	}
	return result;
}

function controlOccurrences(ribbon: RibbonDefinition): Map<string, ControlOccurrence[]> {
	const occurrences = new Map<string, ControlOccurrence[]>();
	for (const tab of ribbon.tabs) {
		for (const group of tab.groups) {
			const ordinals = new Map<string, number>();
			group.buttons.forEach((button, index) => {
				const ordinal = ordinals.get(button.id) ?? 0;
				ordinals.set(button.id, ordinal + 1);
				const key = JSON.stringify([tab.id, group.id, button.id, ordinal]);
				const previous = occurrences.get(button.id) ?? [];
				previous.push({ button, groupId: group.id, tabId: tab.id, ordinal, index, key });
				occurrences.set(button.id, previous);
			});
		}
	}
	return occurrences;
}

/** Valid platform control reuse is permitted only when EVERY occurrence remains unedited. */
function unchangedReusedControlIds(current: RibbonDefinition, baseline: RibbonDefinition): Set<string> {
	const before = controlOccurrences(baseline);
	const after = controlOccurrences(current);
	const reused = new Set<string>();
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		const previous = before.get(id) ?? [];
		const next = after.get(id) ?? [];
		if (previous.length <= 1 && next.length <= 1) continue;
		if (previous.length < 2 || next.length !== previous.length) {
			throw new Error(`Ambiguous duplicate control id "${id}": occurrence added or removed.`);
		}
		const nextByKey = new Map(next.map(occurrence => [occurrence.key, occurrence]));
		for (const occurrence of previous) {
			const counterpart = nextByKey.get(occurrence.key);
			if (!counterpart || !sameModel(occurrence.button, counterpart.button)) {
				throw new Error(`Ambiguous duplicate control id "${id}": a reused platform occurrence was edited or moved.`);
			}
		}
		reused.add(id);
	}
	if (!reused.size) return reused;
	const beforeGroups = new Map(baseline.tabs.flatMap(tab =>
		tab.groups.map(group => [JSON.stringify([tab.id, group.id]), group] as const)));
	const afterGroups = new Map(current.tabs.flatMap(tab =>
		tab.groups.map(group => [JSON.stringify([tab.id, group.id]), group] as const)));
	const occurrenceOrder = (group: RibbonGroup): string[] => {
		const ordinals = new Map<string, number>();
		return group.buttons.map(button => {
			const ordinal = ordinals.get(button.id) ?? 0;
			ordinals.set(button.id, ordinal + 1);
			return JSON.stringify([button.id, ordinal]);
		});
	};
	for (const [groupKey, previous] of beforeGroups) {
		if (!previous.buttons.some(button => reused.has(button.id))) continue;
		const next = afterGroups.get(groupKey);
		if (!next) continue; // Disappearing duplicate occurrences were rejected above.
		const beforeOrder = occurrenceOrder(previous);
		const afterOrder = occurrenceOrder(next);
		const common = new Set(beforeOrder.filter(key => afterOrder.includes(key)));
		if (!sameModel(beforeOrder.filter(key => common.has(key)), afterOrder.filter(key => common.has(key)))) {
			throw new Error(`Ambiguous duplicate control in group ${previous.id}: a reused occurrence moved relative to its siblings.`);
		}
	}
	return reused;
}

function buttonPlacements(ribbon: RibbonDefinition, ignoredIds: ReadonlySet<string> = new Set()): Map<string, ControlPlacement> {
	const placements = new Map<string, ControlPlacement>();
	for (const tab of ribbon.tabs) {
		for (const group of tab.groups) {
			group.buttons.forEach((button, index) => {
				if (ignoredIds.has(button.id)) return;
				if (placements.has(button.id)) throw new Error(`Ambiguous duplicate control id "${button.id}"; ribbon import aborted.`);
				placements.set(button.id, { button, groupId: group.id, index });
			});
		}
	}
	return placements;
}

function reorderedGroupIds(current: RibbonDefinition, baseline: RibbonDefinition, ignoredIds: ReadonlySet<string> = new Set()): Set<string> {
	const original = new Map(baseline.tabs.flatMap(tab => tab.groups.map(group => [group.id, group] as const)));
	const beforePlacements = buttonPlacements(baseline, ignoredIds);
	const reordered = new Set<string>();
	for (const tab of current.tabs) {
		for (const group of tab.groups) {
			const before = original.get(group.id);
			const editableButtons = group.buttons.filter(button => !ignoredIds.has(button.id));
			const originalEditableButtons = before?.buttons.filter(button => !ignoredIds.has(button.id)) ?? [];
			const structuralEdit = !before || editableButtons.length !== originalEditableButtons.length ||
				editableButtons.some(button => beforePlacements.get(button.id)?.groupId !== group.id);
			// New/moved controls may retain an old sequence that collides with a
			// sibling. Normalize the affected group's entire ordered set so CRM
			// receives stable 10,20,... positions without ambiguous ties.
			if (structuralEdit && group.buttons.some((button, index) => index > 0 && button.sequence <= group.buttons[index - 1].sequence)) {
				reordered.add(group.id);
			}
			if (!before) continue;
			// Ignore insertions/removals/relocations here: those have their own intent.
			const oldOrder = originalEditableButtons.map(b => b.id).filter(id => editableButtons.some(b => b.id === id));
			const newOrder = editableButtons.map(b => b.id).filter(id => originalEditableButtons.some(b => b.id === id));
			if (!sameModel(oldOrder, newOrder)) reordered.add(group.id);
		}
	}
	return reordered;
}

/** Restrict edits of shared definitions to IDs actually used by this ribbon scope. */
function referencedDefinitions(
	current: RibbonDefinition,
	baseline: RibbonDefinition,
	definitions: RibbonDefinitions,
	baselineDefinitions?: RibbonDefinitions,
): { commandIds: Set<string>; enableRuleIds: Set<string>; displayRuleIds: Set<string>; locLabelIds: Set<string> } {
	const commandIds = new Set<string>();
	const locLabelIds = new Set<string>();
	for (const ribbon of [current, baseline]) {
		for (const tab of ribbon.tabs) {
			if (tab.commandId) commandIds.add(tab.commandId);
			locLabelIds.add(`${tab.id}.Title`);
			for (const group of tab.groups) {
				locLabelIds.add(`${group.id}.Title`);
				for (const button of group.buttons) {
					if (button.commandId) commandIds.add(button.commandId);
					locLabelIds.add(buttonLabelId(button.id));
					locLabelIds.add(buttonTooltipTitleId(button.id));
					locLabelIds.add(buttonTooltipBodyId(button.id));
					for (const value of [button.label, button.tooltipTitle, button.tooltipBody, button.sourceXml]) {
						if (!value) continue;
						for (const ref of value.matchAll(/\$LocLabels:([^\s"'&<>]+)/g)) locLabelIds.add(ref[1]);
					}
				}
			}
		}
	}
	const enableRuleIds = new Set<string>();
	const displayRuleIds = new Set<string>();
	for (const command of [...definitions.commands, ...(baselineDefinitions?.commands ?? [])]) {
		if (!commandIds.has(command.id)) continue;
		for (const id of command.enableRules) enableRuleIds.add(id);
		for (const id of command.displayRules) displayRuleIds.add(id);
	}
	return { commandIds, enableRuleIds, displayRuleIds, locLabelIds };
}

/**
 * Generates a RibbonDiffXml document from the delta between current and baseline state.
 * Only elements that differ from the baseline are included (delta-only approach).
 */
/**
 * Properties that mark an OOB button as "modified from baseline" and therefore
 * needing an override CustomAction in the RibbonDiffXml. Behavior properties
 * (sequence, hidden, oob, custom, managed, kind) are intentionally NOT in this
 * list — `sequence` is rewritten by the canvas when ordering changes regardless
 * of edit intent, and `hidden` already has its own HideCustomAction path.
 */
const OOB_OVERRIDE_DIFF_FIELDS = [
	"label",
	"icon",
	"image16",
	"image32",
	"tooltipTitle",
	"tooltipBody",
	"commandId",
	"templateAlias",
] as const satisfies readonly (keyof RibbonButton)[];

function hasOobOverrideChanges(base: RibbonButton, current: RibbonButton): boolean {
	for (const field of OOB_OVERRIDE_DIFF_FIELDS) {
		if ((base[field] ?? "") !== (current[field] ?? "")) return true;
	}
	return false;
}

export function generateRibbonDelta(input: GeneratorInput): RibbonDelta {
	const { current, baseline, baselineDefinitions } = input;
	const definitions: RibbonDefinitions = input.definitions ?? {
		commands: input.commands,
		enableRules: input.enableRules,
		displayRules: input.displayRules,
		locLabels: input.locLabels,
	};
	const { commands, enableRules, displayRules, locLabels } = definitions;
	const unchangedReusedIds = unchangedReusedControlIds(current, baseline);
	const basePlacements = buttonPlacements(baseline, unchangedReusedIds);
	const currentPlacements = buttonPlacements(current, unchangedReusedIds);
	const reorderedGroups = reorderedGroupIds(current, baseline, unchangedReusedIds);
	for (const tab of current.tabs) {
		for (const group of tab.groups) {
			if (reorderedGroups.has(group.id) && group.buttons.some(button => unchangedReusedIds.has(button.id))) {
				throw new Error(`Ambiguous duplicate control in group ${group.id}: sequence normalization would rewrite an unchanged reused platform control.`);
			}
		}
	}
	const baselineCommandMap = byIdUnique(baselineDefinitions?.commands ?? [], c => c.id, "baseline command");
	const baselineEnableMap = byIdUnique(baselineDefinitions?.enableRules ?? [], r => r.id, "baseline enable rule");
	const baselineDisplayMap = byIdUnique(baselineDefinitions?.displayRules ?? [], r => r.id, "baseline display rule");
	const baselineLabelMap = byIdUnique(baselineDefinitions?.locLabels ?? [], l => l.id, "baseline localized label");
	byIdUnique(commands, c => c.id, "command");
	byIdUnique(enableRules, r => r.id, "enable rule");
	byIdUnique(displayRules, r => r.id, "display rule");
	byIdUnique(locLabels, l => l.id, "localized label");
	const related = referencedDefinitions(current, baseline, definitions, baselineDefinitions);

	const baselineButtonsById = new Map<string, RibbonButton>();
	const baselineHiddenIds = new Set<string>();
	const baselineTabIds = new Set<string>();
	const baselineGroupIds = new Set<string>();

	for (const baseTab of baseline.tabs) {
		baselineTabIds.add(baseTab.id);
		for (const baseGroup of baseTab.groups) {
			baselineGroupIds.add(baseGroup.id);
			for (const baseButton of baseGroup.buttons) {
				if (unchangedReusedIds.has(baseButton.id)) continue;
				baselineButtonsById.set(baseButton.id, baseButton);
				if (baseButton.hidden) baselineHiddenIds.add(baseButton.id);
			}
		}
	}
	byIdUnique(current.tabs, t => t.id, "tab");
	byIdUnique(baseline.tabs, t => t.id, "baseline tab");
	const currentGroups = byIdUnique(current.tabs.flatMap(t => t.groups), g => g.id, "group");
	const baselineGroups = byIdUnique(baseline.tabs.flatMap(t => t.groups), g => g.id, "baseline group");
	const previousTabs = new Map(baseline.tabs.map(t => [t.id, t]));
	const removedTabIds = baseline.tabs.filter(t => !current.tabs.some(c => c.id === t.id)).map(t => t.id);
	const removedGroupIds = [...baselineGroups.keys()].filter(id => !currentGroups.has(id));
	const removedControlIds = [...basePlacements.keys()].filter(id => !currentPlacements.has(id));
	const unhiddenControlIds = [...currentPlacements.entries()]
		.filter(([id, placement]) => basePlacements.get(id)?.button.hidden && !placement.button.hidden)
		.map(([id]) => id);

	const tabCustomActions: string[] = [];
	const groupCustomActions: string[] = [];
	const customActions: string[] = [];
	const hideCustomActions: string[] = [];

	// LocLabels are emitted per-customization (like Ribbon Workbench) so a
	// `$LocLabels:` reference is NEVER produced without its backing <LocLabel>.
	// `sink` accumulates; we dedupe by Id at the end.
	const collectedLocLabels: LocLabel[] = [];
	const sink = (label: LocLabel) => collectedLocLabels.push(label);
	const elementPatches: NonNullable<RibbonDelta["elementPatches"]> = [];
	const sameSharedOrder = (prior: string[], next: string[]): boolean => {
		const shared = new Set(prior.filter(id => next.includes(id)));
		return sameModel(prior.filter(id => shared.has(id)), next.filter(id => shared.has(id)));
	};
	const priorTabIds = baseline.tabs.map(t => t.id);
	const tabReorder = !sameSharedOrder(priorTabIds, current.tabs.map(t => t.id));
	const baselineGroupParents = new Map(baseline.tabs.flatMap(t => t.groups.map(g => [g.id, t.id] as const)));
	for (const [tabIndex, tab] of current.tabs.entries()) {
		const previous = previousTabs.get(tab.id);
		if (!previous && tab.sourceXml && tab.sourceXml.includes("<Menu")) {
			throw new Error(`Unsafe cloning of tab ${tab.id}: an unsupported source subtree would be lost.`);
		}
		if (previous) {
			const attrs: Record<string, string | null> = {};
			if (tab.label !== previous.label) {
				attrs.Title = resolveLocalizedAttr(tab.label, `${tab.id}.Title`, locLabels, sink);
			}
			if (tab.commandId !== previous.commandId) attrs.Command = tab.commandId || null;
			if (tab.template !== previous.template) attrs.Template = tab.template || null;
			if (tabReorder || tab.sequence !== previous.sequence) attrs.Sequence = String(tabReorder ? (tabIndex + 1) * 10 : tab.sequence);
			if (Object.keys(attrs).length > 0) elementPatches.push({ kind: "Tab", id: tab.id, attributes: attrs });
		}
		const originalGroupIds = previous?.groups.map(g => g.id) ?? [];
		const groupReorder = !sameSharedOrder(originalGroupIds, tab.groups.map(g => g.id));
		for (const [groupIndex, group] of tab.groups.entries()) {
			const before = baselineGroups.get(group.id);
			if (!before) continue;
			if (baselineGroupParents.get(group.id) !== tab.id) {
				throw new Error(`Unrepresentable edit of group ${group.id}: moving a whole merged group requires explicit relocation intent.`);
			}
			const attrs: Record<string, string | null> = {};
			if (group.label !== before.label) attrs.Title = resolveLocalizedAttr(group.label, `${group.id}.Title`, locLabels, sink);
			if (group.template !== before.template) attrs.Template = group.template ? normalizeGroupTemplate(group.template) : null;
			if (groupReorder || group.sequence !== before.sequence) attrs.Sequence = String(groupReorder ? (groupIndex + 1) * 10 : group.sequence);
			if (Object.keys(attrs).length > 0) elementPatches.push({ kind: "Group", id: group.id, attributes: attrs });
		}
	}

	// The set of buttons that actually produced a CustomAction. Dependency
	// collection (commands / rules / loc-labels) is scoped to THESE only —
	// never the untouched ribbon. Emission is CHANGE-BASED (new / modified /
	// hidden vs. the loaded baseline), NOT provenance-based: ribbon import is
	// additive/merge-by-id, so an unchanged button (OOB, managed first-party,
	// ISV, or your own already-live one) never needs re-emitting and must not be
	// — that's what keeps a publish from ever corrupting components CBS doesn't
	// own. (Provenance — OOB/managed/unmanaged — is a UI concern only; see
	// ribbonLayerService. The generator deliberately ignores button.custom.)
	const emittedButtons: RibbonButton[] = [];

	// 1. New tabs (not present in the OOB baseline) — emit the whole tab with
	//    its groups so the buttons inside have an anchor. Documented anchor:
	//    Location="Mscrm.Tabs._children".
	for (const tab of current.tabs) {
		if (!baselineTabIds.has(tab.id)) {
			tabCustomActions.push(generateTabCustomAction(tab, sink));
		}
	}

	// 2. New groups inside an EXISTING tab → Location="{tabId}.Groups._children".
	//    (Groups inside a brand-new tab are emitted by the new-tab branch above.)
	for (const tab of current.tabs) {
		if (!baselineTabIds.has(tab.id)) continue;
		for (const group of tab.groups) {
			if (!baselineGroupIds.has(group.id)) {
				groupCustomActions.push(generateGroupCustomAction(group, tab.id, sink));
			}
		}
	}

	// 3. Buttons.
	for (const tab of current.tabs) {
		for (const group of tab.groups) {
			for (const [index, button] of group.buttons.entries()) {
					if (unchangedReusedIds.has(button.id)) continue;
					const baseButton = baselineButtonsById.get(button.id);
				if (baseButton && button.kind !== baseButton.kind) {
					throw new Error(`Unrepresentable edit of control ${button.id}: changing the control kind requires an explicit replacement.`);
				}
				const moved = !!baseButton && basePlacements.get(button.id)?.groupId !== group.id;
				const reordered = reorderedGroups.has(group.id);
				const sequence = reordered ? (index + 1) * 10 : button.sequence;
				const changed = !!baseButton && (hasOobOverrideChanges(baseButton, button) || baseButton.sequence !== button.sequence || reordered);
				if (!baseButton || moved || changed) {
					if (moved) removedControlIds.push(button.id);
					if (!baseButton || moved) {
						customActions.push(generateCustomAction(button, group.id, locLabels, sink, baseButton, sequence, moved));
					} else {
						customActions.push(generateOobOverrideCustomAction(button, locLabels, sink, baseButton, sequence));
					}
					emittedButtons.push(button);
				}
				if (button.hidden && !baselineHiddenIds.has(button.id)) {
					// A new hidden control requires BOTH creation and the hide action.
					hideCustomActions.push(generateHideCustomAction(button, group.id));
				}
			}
		}
	}

	// Collect referenced commands / rules from the EMITTED buttons only.
	const referencedCommandIds = new Set<string>();
	for (const button of emittedButtons) {
		if (button.commandId) referencedCommandIds.add(button.commandId);
	}
	for (const command of commands) {
		if (!related.commandIds.has(command.id)) continue;
		if (command.actions.some(a => a.kind !== "javascript" && a.kind !== "url")) {
			throw new Error(`Unsupported authored action in ${command.id}: only JavaScriptFunction and Url can be published as classic RibbonDiffXml.`);
		}
		if (!baselineDefinitions && isSystemRibbonId(command.id) && !command.sourceXml && command.actions.length > 0 && referencedCommandIds.has(command.id)) {
			throw new Error(`System command override ${command.id} requires baselineDefinitions proving a deliberate edit.`);
		}
	}

	// A loaded Mscrm.* command can contain JavaScript actions. Action count is
	// therefore NOT proof that a user intentionally overrode it. Only explicitly
	// changed definitions or newly-authored ones are safe to serialize.
	const referencedCommands = commands.filter(
		(c) => {
			if (!related.commandIds.has(c.id)) return false;
			const previous = baselineCommandMap.get(c.id);
			if (baselineDefinitions) return !previous || !sameModel(previous, c);
			return referencedCommandIds.has(c.id) && !c.sourceXml && !isSystemRibbonId(c.id);
		},
	);

	const referencedEnableRuleIds = new Set<string>();
	const referencedDisplayRuleIds = new Set<string>();
	for (const cmd of referencedCommands) {
		cmd.enableRules.forEach((r) => referencedEnableRuleIds.add(r));
		cmd.displayRules.forEach((r) => referencedDisplayRuleIds.add(r));
	}

	const referencedEnableRules = enableRules.filter((r) => {
		if (!related.enableRuleIds.has(r.id) && !referencedEnableRuleIds.has(r.id)) return false;
		const previous = baselineEnableMap.get(r.id);
		if (baselineDefinitions) return !previous || !sameModel(previous, r);
		return referencedEnableRuleIds.has(r.id) && !r.sourceXml && !isSystemRibbonId(r.id);
	});
	const referencedDisplayRules = displayRules.filter((r) => {
		if (!related.displayRuleIds.has(r.id) && !referencedDisplayRuleIds.has(r.id)) return false;
		const previous = baselineDisplayMap.get(r.id);
		if (baselineDefinitions) return !previous || !sameModel(previous, r);
		return referencedDisplayRuleIds.has(r.id) && !r.sourceXml && !isSystemRibbonId(r.id);
	});
	const changedLabels = locLabels.filter((l) =>
		baselineDefinitions && related.locLabelIds.has(l.id) &&
		(!baselineLabelMap.has(l.id) || !sameModel(baselineLabelMap.get(l.id), l)),
	);
	const referencedLocLabels = dedupeLocLabels([...collectedLocLabels, ...changedLabels]);
	const removedCommandIds = [...baselineCommandMap.keys()].filter(id => related.commandIds.has(id) && !commands.some(c => c.id === id));
	const removedEnableRuleIds = [...baselineEnableMap.keys()].filter(id => related.enableRuleIds.has(id) && !enableRules.some(r => r.id === id));
	const removedDisplayRuleIds = [...baselineDisplayMap.keys()].filter(id => related.displayRuleIds.has(id) && !displayRules.some(r => r.id === id));
	const removedLocLabelIds = [...baselineLabelMap.keys()].filter(id => related.locLabelIds.has(id) && !locLabels.some(l => l.id === id));

	const commandDefsXml = referencedCommands.map(c => generateCommandDefinition(c, baselineCommandMap.get(c.id))).join("\n    ");
	const enableRulesXml = referencedEnableRules.map(r => generateEnableRule(r, baselineEnableMap.get(r.id))).join("\n      ");
	const displayRulesXml = referencedDisplayRules.map(r => generateDisplayRule(r, baselineDisplayMap.get(r.id))).join("\n      ");
	const locLabelsXml = referencedLocLabels.map(generateLocLabel).join("\n    ");

	const allCustomActions = [
		...tabCustomActions,
		...groupCustomActions,
		...customActions,
		...hideCustomActions,
	];

	const originalTabRules = byIdUnique(baseline.tabs.flatMap(t => t.tabDisplayRules), r => r.tabCommand, "baseline tab display rule");
	const editedTabRules = byIdUnique(current.tabs.flatMap(t => t.tabDisplayRules), r => r.tabCommand, "tab display rule");
	const removedTabDisplayRuleCommands = [...originalTabRules.keys()].filter(id => !editedTabRules.has(id));
	const tabDisplayRulesXml = current.tabs.map(tab => {
		const changed = tab.tabDisplayRules.filter(rule => !originalTabRules.has(rule.tabCommand) || !sameModel(originalTabRules.get(rule.tabCommand), rule));
		return changed.length ? generateTabDisplayRulesForTab({ ...tab, tabDisplayRules: changed }) : "";
	}).filter(Boolean).join("\n      ");

	const scalingXml = generateScalingsXml(current, baseline);
	const removedScalingTabIds = Object.keys(baseline.scalingByTab ?? {}).filter(id => !current.scalingByTab?.[id]);

	// IMPORTANT — no `<?xml ?>` declaration here.
	//
	// This function returns a RibbonDiffXml *fragment* that is later embedded
	// inside customizations.xml by `wrapInCustomizationsXml`, which supplies
	// the single outer XML declaration the document is allowed to have.
	// Including a declaration here causes Dataverse to reject the import:
	//   0x8004801a: Unexpected XML declaration. The XML declaration must be
	//   the first node in the document, and no white space characters are
	//   allowed to appear before it.
	//
	// If you need a standalone, viewable XML string (e.g. for the XML drawer
	// or a download button), prepend `<?xml version="1.0" encoding="utf-8"?>\n`
	// at the call site.
	const xml = `<RibbonDiffXml>
  <CustomActions>
    ${allCustomActions.join("\n    ")}
  </CustomActions>
  <CommandDefinitions>
    ${commandDefsXml}
  </CommandDefinitions>
  <RuleDefinitions>
    <TabDisplayRules>
      ${tabDisplayRulesXml}
    </TabDisplayRules>
    <DisplayRules>
      ${displayRulesXml}
    </DisplayRules>
    <EnableRules>
      ${enableRulesXml}
    </EnableRules>
  </RuleDefinitions>
  ${scalingXml}
  <LocLabels>
    ${locLabelsXml}
  </LocLabels>
</RibbonDiffXml>`;
	return {
		xml,
		elementPatches,
		removedControlIds: [...new Set(removedControlIds)],
		removedGroupIds,
		removedTabIds,
		unhiddenControlIds,
		removedCommandIds,
		removedEnableRuleIds,
		removedDisplayRuleIds,
		removedLocLabelIds,
		removedTabDisplayRuleCommands,
		removedScalingTabIds,
	};
}

/** Compatibility for existing XML preview and publish callers. */
export function generateRibbonDiffXml(input: GeneratorInput): string {
	return generateRibbonDelta(input).xml;
}

/**
 * Returns a structured summary of what changed in this ribbon scope so
 * callers (BulkPublishModal, status indicators) can decide whether there's
 * anything worth publishing at all.
 *
 * Empty summary means the user hasn't touched this scope and importing it
 * would just round-trip an empty RibbonDiffXml through Dataverse — wasteful,
 * and (worse) it surfaces unrelated import errors for scopes the user didn't
 * even modify (the famous Application-ribbon RootComponent issue).
 */
export interface RibbonDiffSummary {
	newButtons: number;
	overriddenButtons: number;
	hiddenButtons: number;
	newTabs: number;
	newGroups: number;
	scalingChanges: number;
	tabDisplayRules: number;
	removedControls: number;
	unhiddenControls: number;
	movedControls: number;
	reorderedGroups: number;
	reorderedTabs: number;
	reorderedGroupContainers: number;
	changedTabs: number;
	changedGroups: number;
	changedDefinitions: number;
	hasAnyChange: boolean;
}

export function summarizeRibbonDiff(
	current: RibbonDefinition,
	baseline: RibbonDefinition,
	definitions?: RibbonDefinitions,
	baselineDefinitions?: RibbonDefinitions,
): RibbonDiffSummary {
	const unchangedReusedIds = unchangedReusedControlIds(current, baseline);
	const baselineButtonsById = new Map<string, RibbonButton>();
	const baselineHiddenIds = new Set<string>();
	const baselineTabIds = new Set<string>();
	const baselineGroupIds = new Set<string>();

	for (const baseTab of baseline.tabs) {
		baselineTabIds.add(baseTab.id);
		for (const baseGroup of baseTab.groups) {
			baselineGroupIds.add(baseGroup.id);
			for (const baseButton of baseGroup.buttons) {
				if (unchangedReusedIds.has(baseButton.id)) continue;
				baselineButtonsById.set(baseButton.id, baseButton);
				if (baseButton.hidden) baselineHiddenIds.add(baseButton.id);
			}
		}
	}

	let newButtons = 0;
	let overriddenButtons = 0;
	let hiddenButtons = 0;
	let newTabs = 0;
	let newGroups = 0;
	let tabDisplayRules = 0;
	let changedTabs = 0;
	let changedGroups = 0;
	const placements = buttonPlacements(current, unchangedReusedIds);
	const basePlacements = buttonPlacements(baseline, unchangedReusedIds);
	const removedControls = [...basePlacements.keys()].filter(id => !placements.has(id)).length;
	const unhiddenControls = [...placements.entries()].filter(([id, p]) => basePlacements.get(id)?.button.hidden && !p.button.hidden).length;
	const movedControls = [...placements.entries()].filter(([id, p]) => {
		const before = basePlacements.get(id);
		return !!before && before.groupId !== p.groupId;
	}).length;
	const reorderedGroupIdsForSummary = reorderedGroupIds(current, baseline, unchangedReusedIds);
	for (const tab of current.tabs) {
		for (const group of tab.groups) {
			if (reorderedGroupIdsForSummary.has(group.id) && group.buttons.some(button => unchangedReusedIds.has(button.id))) {
				throw new Error(`Ambiguous duplicate control in group ${group.id}: sequence normalization would rewrite a reused platform control.`);
			}
		}
	}
	const reorderedGroups = reorderedGroupIdsForSummary.size;
	const originalTabs = new Map(baseline.tabs.map(t => [t.id, t]));
	const originalGroups = new Map(baseline.tabs.flatMap(t => t.groups.map(g => [g.id, g] as const)));
	const changedRelativeOrder = (before: string[], after: string[]): boolean => {
		const shared = new Set(before.filter(id => after.includes(id)));
		return !sameModel(before.filter(id => shared.has(id)), after.filter(id => shared.has(id)));
	};
	const reorderedTabs = changedRelativeOrder(baseline.tabs.map(t => t.id), current.tabs.map(t => t.id)) ? 1 : 0;
	const reorderedGroupContainers = current.tabs.filter(tab => {
		const previous = originalTabs.get(tab.id);
		return previous && changedRelativeOrder(previous.groups.map(g => g.id), tab.groups.map(g => g.id));
	}).length;
	const baselineTabRules = new Map(baseline.tabs.flatMap(t => t.tabDisplayRules.map(r => [r.tabCommand, r] as const)));

	for (const tab of current.tabs) {
		if (!baselineTabIds.has(tab.id)) newTabs++;
		else if (originalTabs.has(tab.id)) {
			const before = originalTabs.get(tab.id)!;
			if (before.label !== tab.label || before.sequence !== tab.sequence || before.commandId !== tab.commandId || before.template !== tab.template) changedTabs++;
		}
		for (const rule of tab.tabDisplayRules ?? []) {
			if (!baselineTabRules.has(rule.tabCommand) || !sameModel(rule, baselineTabRules.get(rule.tabCommand))) tabDisplayRules++;
		}
		for (const group of tab.groups) {
			if (!baselineGroupIds.has(group.id) && baselineTabIds.has(tab.id)) newGroups++;
			else if (originalGroups.has(group.id)) {
				const before = originalGroups.get(group.id)!;
				if (before.label !== group.label || before.template !== group.template || before.sequence !== group.sequence) changedGroups++;
			}
			for (const button of group.buttons) {
				if (unchangedReusedIds.has(button.id)) continue;
				const baseButton = baselineButtonsById.get(button.id);
				if (button.hidden && !baselineHiddenIds.has(button.id)) {
					hiddenButtons++;
				} else if (!baseButton) {
					newButtons++;
				} else if (hasOobOverrideChanges(baseButton, button) || baseButton.sequence !== button.sequence || baseButton.kind !== button.kind) {
					overriddenButtons++;
				}
			}
		}
	}
	tabDisplayRules += [...baselineTabRules.keys()].filter(id => !current.tabs.some(t => t.tabDisplayRules.some(r => r.tabCommand === id))).length;
	const removedTabs = baseline.tabs.filter(t => !current.tabs.some(c => c.id === t.id)).length;
	const removedGroups = [...originalGroups.keys()].filter(id => !current.tabs.some(t => t.groups.some(g => g.id === id))).length;

	// Scaling: count distinct tabs whose scaling differs from baseline.
	const currentScaling = current.scalingByTab ?? {};
	const baselineScaling = baseline.scalingByTab ?? {};
	let scalingChanges = 0;
	for (const [tabId, scaling] of Object.entries(currentScaling)) {
		if (!sameModel(scaling, baselineScaling[tabId])) scalingChanges++;
	}
	scalingChanges += Object.keys(baselineScaling).filter(id => currentScaling[id] === undefined).length;
	let changedDefinitions = 0;
	if (definitions && baselineDefinitions) {
		const ids = referencedDefinitions(current, baseline, definitions, baselineDefinitions);
		for (const [kind, used] of [
			["commands", ids.commandIds],
			["enableRules", ids.enableRuleIds],
			["displayRules", ids.displayRuleIds],
			["locLabels", ids.locLabelIds],
		] as const) {
			const before = new Map(baselineDefinitions[kind].map(item => [item.id, item]));
			const after = new Map(definitions[kind].map(item => [item.id, item]));
			for (const id of new Set([...before.keys(), ...after.keys()])) {
				if (used.has(id) && !sameModel(before.get(id), after.get(id))) changedDefinitions++;
			}
		}
	}

	const hasAnyChange =
		newButtons + overriddenButtons + hiddenButtons + newTabs + newGroups + scalingChanges +
		removedTabs + removedGroups + removedControls + unhiddenControls + movedControls + reorderedGroups + reorderedTabs + reorderedGroupContainers +
		changedTabs + changedGroups + changedDefinitions + tabDisplayRules > 0;

	return {
		newButtons,
		overriddenButtons,
		hiddenButtons,
		newTabs,
		newGroups,
		scalingChanges,
		tabDisplayRules,
		removedControls,
		unhiddenControls,
		movedControls,
		reorderedGroups,
		reorderedTabs,
		reorderedGroupContainers,
		changedTabs,
		changedGroups,
		changedDefinitions,
		hasAnyChange,
	};
}

function generateScalingsXml(current: RibbonDefinition, baseline: RibbonDefinition): string {
	const currentScaling = current.scalingByTab ?? {};
	const baselineScaling = baseline.scalingByTab ?? {};
	const changed = Object.entries(currentScaling)
		.filter(
			([tabId, scaling]) => !sameModel(scaling, baselineScaling[tabId]),
		)
		.map(([_, scaling]) => scaling);

	if (changed.length === 0) {
		return "";
	}

	const body = changed.map(generateScalingDefinition).join("\n    ");
	return `<Scalings>
    ${body}
  </Scalings>`;
}

function generateScalingDefinition(scaling: ScalingDefinition): string {
	if (scaling.sourceXml) {
		const original = parseSourceElement(scaling.sourceXml, "Scaling", scaling.tabId);
		original.setAttribute("TabId", scaling.tabId);
		const inputSteps = [
			...scaling.maxSizes.map(step => ({ tag: "MaxSize" as const, step })),
			...scaling.scales.map(step => ({ tag: "Scale" as const, step })),
		];
		const prior = [...original.children];
		if (prior.some(child => child.tagName !== "MaxSize" && child.tagName !== "Scale")) {
			throw new Error(`Unsafe partial rewrite of scaling ${scaling.tabId}: unknown child XML.`);
		}
		const seenSteps = new Set<string>();
		const authored = inputSteps.map(({ tag, step }) => {
			const key = `${tag}:${step.id}`;
			if (seenSteps.has(key)) throw new Error(`Duplicate scaling item ${step.id} in ${scaling.tabId}.`);
			seenSteps.add(key);
			const candidates = prior.filter(el => el.tagName === tag && el.getAttribute("Id") === step.id);
			if (candidates.length > 1) throw new Error(`Ambiguous duplicate scaling declaration ${step.id}.`);
			const element = candidates[0] ?? original.ownerDocument.createElement(tag);
			element.setAttribute("Id", step.id);
			element.setAttribute("GroupId", step.groupId);
			element.setAttribute("Size", step.size);
			element.setAttribute("Sequence", String(step.sequence));
			return element;
		});
		for (const old of prior) original.removeChild(old);
		for (const child of authored) original.appendChild(child);
		return new XMLSerializer().serializeToString(original);
	}
	const maxSizeXml = scaling.maxSizes
		.map(
			(step) =>
				`<MaxSize Id="${escapeXml(step.id)}" GroupId="${escapeXml(step.groupId)}" Size="${escapeXml(step.size)}" Sequence="${step.sequence}"/>`,
		)
		.join("\n      ");
	const scaleXml = scaling.scales
		.map(
			(step) =>
				`<Scale Id="${escapeXml(step.id)}" GroupId="${escapeXml(step.groupId)}" Size="${escapeXml(step.size)}" Sequence="${step.sequence}"/>`,
		)
		.join("\n      ");

	return `<Scaling TabId="${escapeXml(scaling.tabId)}">
      ${maxSizeXml}
      ${scaleXml}
    </Scaling>`;
}

// ---------------------------------------------------------------------------
// CustomAction generators
// ---------------------------------------------------------------------------

function generateCustomAction(
	button: RibbonButton,
	groupId: string,
	storeLocLabels: LocLabel[],
	sink: (label: LocLabel) => void,
	baseButton?: RibbonButton,
	sequence = button.sequence,
	isMove = false,
): string {
	const location = `${groupId}.Controls._children`;
	return `<CustomAction Id="${escapeXml(button.id)}.${isMove ? "Move." : ""}CustomAction"
    Location="${escapeXml(location)}"
	    Sequence="${sequence}">
	    <CommandUIDefinition>
	      ${generateButtonElement(button, storeLocLabels, sink, baseButton, sequence)}
    </CommandUIDefinition>
  </CustomAction>`;
}

function generateOobOverrideCustomAction(
	button: RibbonButton,
	storeLocLabels: LocLabel[],
	sink: (label: LocLabel) => void,
	baseButton?: RibbonButton,
	sequence = button.sequence,
): string {
	// Override: Location = existing button ID (MS-documented pattern for
	// "change the definition of an existing item").
	return `<CustomAction Id="${escapeXml(button.id)}.Override.CustomAction"
    Location="${escapeXml(button.id)}"
	    Sequence="${sequence}">
	    <CommandUIDefinition>
	      ${generateButtonElement(button, storeLocLabels, sink, baseButton, sequence)}
    </CommandUIDefinition>
  </CustomAction>`;
}

function generateHideCustomAction(button: RibbonButton, _groupId: string): string {
	return `<HideCustomAction HideActionId="${escapeXml(button.id)}.HideAction"
    Location="${escapeXml(button.id)}"/>`;
}

/**
 * Emits a CustomAction that creates a NEW group inside an existing tab.
 * Location pattern per Microsoft docs: `{tabId}.Groups._children`. The group's
 * `<Controls>` is left empty here — the buttons inside it are emitted as their
 * own CustomActions targeting `{groupId}.Controls._children`.
 */
function generateGroupCustomAction(
	group: RibbonGroup,
	tabId: string,
	sink: (label: LocLabel) => void,
): string {
	const titleId = `${group.id}.Title`;
	sink({ id: titleId, titles: [{ languageCode: 1033, description: group.label }] });
	return `<CustomAction Id="${escapeXml(group.id)}.CustomAction"
    Location="${escapeXml(tabId)}.Groups._children"
    Sequence="${group.sequence}">
    <CommandUIDefinition>
      ${generateGroupElement(group, sink, false)}
    </CommandUIDefinition>
  </CustomAction>`;
}

/**
 * Emits a CustomAction that creates a NEW tab. Documented anchor for adding a
 * tab to an entity ribbon: `Location="Mscrm.Tabs._children"`. The tab's groups
 * are emitted inline (so buttons inside them have an anchor); the buttons
 * themselves are still emitted as separate CustomActions targeting
 * `{groupId}.Controls._children`.
 */
function generateTabCustomAction(tab: RibbonTab, sink: (label: LocLabel) => void): string {
	const titleId = `${tab.id}.Title`;
	sink({ id: titleId, titles: [{ languageCode: 1033, description: tab.label }] });
	const commandAttr = tab.commandId ? ` Command="${escapeXml(tab.commandId)}"` : "";
	const groupsXml = tab.groups.map((g) => generateGroupElement(g, sink, true)).join("\n        ");
	return `<CustomAction Id="${escapeXml(tab.id)}.CustomAction"
    Location="Mscrm.Tabs._children"
    Sequence="${tab.sequence}">
    <CommandUIDefinition>
      <Tab Id="${escapeXml(tab.id)}"${commandAttr} Title="${escapeXml(locLabelRef(titleId))}" Sequence="${tab.sequence}">
        <Groups Id="${escapeXml(tab.id)}.Groups">
        ${groupsXml}
        </Groups>
      </Tab>
    </CommandUIDefinition>
  </CustomAction>`;
}

/**
 * A `<Group>` element with an empty `<Controls>` collection. Used both inside a
 * new-tab CustomAction and (standalone) inside a new-group CustomAction.
 * `nested` controls indentation only.
 */
function generateGroupElement(
	group: RibbonGroup,
	sink: (label: LocLabel) => void,
	nested: boolean,
): string {
	const titleId = `${group.id}.Title`;
	if (nested) {
		// Group title LocLabel is registered by the caller for standalone groups;
		// for nested (new-tab) groups, register it here.
		sink({ id: titleId, titles: [{ languageCode: 1033, description: group.label }] });
	}
	const template = normalizeGroupTemplate(group.template);
	return `<Group Id="${escapeXml(group.id)}" Title="${escapeXml(locLabelRef(titleId))}" Sequence="${group.sequence}" Template="${escapeXml(template)}">
          <Controls Id="${escapeXml(group.id)}.Controls"/>
        </Group>`;
}

/**
 * Group `Template` must be a fully-qualified template id (e.g.
 * `Mscrm.Templates.Flexible2`). The CBS model often stores just the short name
 * (`Flexible2`), so qualify it when no namespace is present.
 */
function normalizeGroupTemplate(template: string): string {
	const t = template?.trim();
	if (!t) return "Mscrm.Templates.Flexible2";
	return t.includes(".") ? t : `Mscrm.Templates.${t}`;
}

/**
 * Resolves a button text field (label / tooltip) into a ribbon attribute value,
 * registering the backing LocLabel so a `$LocLabels:` reference is never
 * dangling (the #1 documented cause of "import succeeds but button doesn't
 * appear" — the ribbon-metadata compile fails to resolve the missing label).
 *
 *   - `$LocLabels:<id>`  → reference as-is; emit the matching store LocLabel
 *                          (or a placeholder so the reference still resolves).
 *   - `$Resources:<key>` → built-in platform resource; reference as-is, no LocLabel.
 *   - plain text         → synthesize `$LocLabels:<conventionId>` and emit a
 *                          LocLabel whose 1033 title is the text, merged with any
 *                          extra-language titles from the Localization editor.
 */
function resolveLocalizedAttr(
	rawValue: string,
	conventionId: string,
	storeLocLabels: LocLabel[],
	sink: (label: LocLabel) => void,
): string {
	const value = rawValue ?? "";
	if (value.startsWith("$LocLabels:")) {
		const id = value.slice("$LocLabels:".length);
		const existing = storeLocLabels.find((l) => l.id === id);
		sink(existing ?? { id, titles: [{ languageCode: 1033, description: id }] });
		return value;
	}
	if (value.startsWith("$Resources:")) {
		return value;
	}
	const titles = [{ languageCode: 1033, description: value }];
	const existing = storeLocLabels.find((l) => l.id === conventionId);
	if (existing) {
		for (const t of existing.titles) {
			if (t.languageCode !== 1033) titles.push(t);
		}
	}
	sink({ id: conventionId, titles });
	return locLabelRef(conventionId);
}

function generateButtonElement(
	button: RibbonButton,
	storeLocLabels: LocLabel[],
	sink: (label: LocLabel) => void,
	baseButton?: RibbonButton,
	sequence = button.sequence,
): string {
	const tag = buttonKindToTag(button.kind);
	if (button.sourceXml) {
		// Patch ONLY edited known attributes in the original subtree. A flyout
		// may contain whole Menus and vendor extension attributes that the visual
		// model does not understand. Serializing from RibbonButton would erase them.
		const el = parseSourceElement(button.sourceXml, tag, button.id);
		if (el.getAttribute("Id") !== button.id && el.querySelector("[Id]")) {
			throw new Error(`Unsafe cloning of nested control ${button.id}: copied menu child IDs would be duplicated.`);
		}
		const changed = <T,>(key: keyof RibbonButton, actual: T) => !baseButton || !sameModel(baseButton[key], actual);
		el.setAttribute("Id", button.id);
		el.setAttribute("Sequence", String(sequence));
		if (changed("label", button.label)) {
			el.setAttribute("LabelText", resolveLocalizedAttr(button.label, buttonLabelId(button.id), storeLocLabels, sink));
		}
		if (changed("commandId", button.commandId)) {
			if (button.commandId) el.setAttribute("Command", button.commandId);
			else el.removeAttribute("Command");
		}
		if (changed("templateAlias", button.templateAlias)) el.setAttribute("TemplateAlias", button.templateAlias);
		if (changed("tooltipTitle", button.tooltipTitle)) {
			if (button.tooltipTitle) el.setAttribute("ToolTipTitle", resolveLocalizedAttr(button.tooltipTitle, buttonTooltipTitleId(button.id), storeLocLabels, sink));
			else el.removeAttribute("ToolTipTitle");
		}
		if (changed("tooltipBody", button.tooltipBody)) {
			if (button.tooltipBody) el.setAttribute("ToolTipDescription", resolveLocalizedAttr(button.tooltipBody, buttonTooltipBodyId(button.id), storeLocLabels, sink));
			else el.removeAttribute("ToolTipDescription");
		}
		if (changed("icon", button.icon) || changed("image32", button.image32) || changed("image16", button.image16)) {
			const valid = (value?: string) => !!value && (value.startsWith("$webresource:") || value.startsWith("$Resources:"));
			const modern = [button.image32, button.image16, button.icon].find(valid);
			if (modern) el.setAttribute("ModernImage", modern);
			else el.removeAttribute("ModernImage");
			if (valid(button.image16)) el.setAttribute("Image16by16", button.image16!);
			else if (changed("image16", button.image16)) el.removeAttribute("Image16by16");
			if (valid(button.image32)) el.setAttribute("Image32by32", button.image32!);
			else if (changed("image32", button.image32)) el.removeAttribute("Image32by32");
		}
		return new XMLSerializer().serializeToString(el);
	}
	const labelAttr = resolveLocalizedAttr(
		button.label,
		buttonLabelId(button.id),
		storeLocLabels,
		sink,
	);
	// Icons MUST reference real web resources (`$webresource:…`). A bare Fluent
	// icon name (e.g. "search") is a CBS-canvas-preview value only — emitting it
	// as ModernImage/Image16by16/Image32by32 produces an unresolvable reference
	// that breaks the ribbon compile and silently drops the button. So we emit
	// icon attributes ONLY for `$webresource:` values, never bare names.
	const isWebResourceRef = (v?: string): v is string => !!v && v.startsWith("$webresource:");
	const modernImage = isWebResourceRef(button.image32)
		? button.image32
		: isWebResourceRef(button.image16)
			? button.image16
			: isWebResourceRef(button.icon)
				? button.icon
				: "";
	const iconAttr = modernImage ? ` ModernImage="${escapeXml(modernImage)}"` : "";
	const image16Attr = isWebResourceRef(button.image16)
		? ` Image16by16="${escapeXml(button.image16)}"`
		: "";
	const image32Attr = isWebResourceRef(button.image32)
		? ` Image32by32="${escapeXml(button.image32)}"`
		: "";
	const tooltipTitleAttr = button.tooltipTitle
		? ` ToolTipTitle="${escapeXml(
			resolveLocalizedAttr(
				button.tooltipTitle,
				buttonTooltipTitleId(button.id),
				storeLocLabels,
				sink,
			),
		)}"`
		: "";
	const tooltipBodyAttr = button.tooltipBody
		? ` ToolTipDescription="${escapeXml(
			resolveLocalizedAttr(
				button.tooltipBody,
				buttonTooltipBodyId(button.id),
				storeLocLabels,
				sink,
			),
		)}"`
		: "";
	const commandAttr = button.commandId ? ` Command="${escapeXml(button.commandId)}"` : "";

	return `<${tag} Id="${escapeXml(button.id)}"${commandAttr}
      LabelText="${escapeXml(labelAttr)}"${tooltipTitleAttr}${tooltipBodyAttr}
      TemplateAlias="${escapeXml(button.templateAlias)}"
	      Sequence="${sequence}"${iconAttr}${image16Attr}${image32Attr}/>`;
}

function parseSourceElement(sourceXml: string, tagName: string, id: string): Element {
	const doc = new DOMParser().parseFromString(sourceXml, "application/xml");
	const el = doc.documentElement;
	if (doc.querySelector("parsererror") || el.tagName !== tagName) {
		throw new Error(`Unsafe partial rewrite of ${id}: original ${tagName} XML is invalid or incompatible.`);
	}
	return el;
}

/**
 * True for platform-owned ribbon element ids that must never be re-defined by a
 * customization (only referenced). Custom solution elements use a publisher
 * prefix, never `Mscrm.` / `Microsoft.`.
 */
function isSystemRibbonId(id: string): boolean {
	return /^(Mscrm|Microsoft)\./.test(id);
}

function dedupeLocLabels(labels: LocLabel[]): LocLabel[] {
	const byId = new Map<string, LocLabel>();
	for (const label of labels) {
		const prev = byId.get(label.id);
		// Prefer the richest definition (most titles) when the same id is
		// collected more than once (e.g. a placeholder vs. a real store entry).
		if (!prev || label.titles.length > prev.titles.length) byId.set(label.id, label);
	}
	return Array.from(byId.values());
}

function buttonKindToTag(kind: RibbonButton["kind"]): string {
	switch (kind) {
		case "flyout":
			return "FlyoutAnchor";
		case "splitButton":
			return "SplitButton";
		case "textBox":
			return "TextBox";
		case "comboBox":
			return "ComboBox";
		case "checkBox":
			return "CheckBox";
		default:
			return "Button";
	}
}

// ---------------------------------------------------------------------------
// Command definition generators
// ---------------------------------------------------------------------------

function generateCommandDefinition(cmd: CommandDefinition, baseline?: CommandDefinition): string {
	for (const action of cmd.actions) {
		if (action.kind !== "javascript" && action.kind !== "url") {
			throw new Error(`Unsupported authored ${action.kind} action in ${cmd.id}: classic RibbonDiffXml cannot serialize this action safely.`);
		}
	}
	if (cmd.sourceXml) {
		const original = parseSourceElement(cmd.sourceXml, "CommandDefinition", cmd.id);
		const actionsChanged = !baseline || !sameModel(baseline.actions, cmd.actions);
		if (actionsChanged) {
			for (const action of [...original.querySelectorAll(":scope > Actions > *")]) {
				const allowed = action.tagName === "JavaScriptFunction"
					? new Set(["Library", "FunctionName"])
					: action.tagName === "Url"
						? new Set(["Address", "PassParams", "WinMode"])
						: null;
				if (!allowed || [...action.attributes].some(attr => !allowed.has(attr.name)) ||
					[...action.children].some(child =>
						!["CrmParameter", "BoolParameter", "IntParameter", "DecimalParameter", "StringParameter"].includes(child.tagName) ||
						[...child.attributes].some(attr => attr.name !== "Name" && attr.name !== "Value") ||
						child.children.length > 0,
					) || [...action.childNodes].some(node =>
						(node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim()) ||
						(node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.ELEMENT_NODE),
					)) {
					throw new Error(`Unsafe partial rewrite of ${cmd.id}: unrecognized action XML would be discarded.`);
				}
			}
		}
		const serialized = generateCommandDefinition({ ...cmd, sourceXml: undefined });
		const replacement = parseSourceElement(serialized, "CommandDefinition", cmd.id);
		for (const [container, updated] of [
			["EnableRules", !baseline || !sameModel(baseline.enableRules, cmd.enableRules)],
			["DisplayRules", !baseline || !sameModel(baseline.displayRules, cmd.displayRules)],
			["Actions", actionsChanged],
		] as const) {
			if (!updated) continue;
			const old = original.querySelector(`:scope > ${container}`);
			if (old && container !== "Actions" && [...old.children].some(e => e.tagName !== container.slice(0, -1))) {
				throw new Error(`Unsafe partial rewrite of ${cmd.id}: unknown ${container} reference XML.`);
			}
			const next = replacement.querySelector(`:scope > ${container}`)!;
			if (old) old.replaceWith(original.ownerDocument.importNode(next, true));
			else original.appendChild(original.ownerDocument.importNode(next, true));
		}
		return new XMLSerializer().serializeToString(original);
	}
	const enableRulesXml = cmd.enableRules
		.map((r) => `<EnableRule Id="${escapeXml(r)}"/>`)
		.join("\n        ");
	const displayRulesXml = cmd.displayRules
		.map((r) => `<DisplayRule Id="${escapeXml(r)}"/>`)
		.join("\n        ");
	const actionsXml = cmd.actions
		.map((a) => {
			if (a.kind === "javascript") {
				const paramsXml = a.params.map(generateActionParam).join("\n          ");
				return `<JavaScriptFunction FunctionName="${escapeXml(a.functionName)}"
          Library="${escapeXml(a.library)}">
          ${paramsXml}
        </JavaScriptFunction>`;
			}
			if (a.kind === "url") {
				const paramsXml = a.params.map(generateActionParam).join("\n          ");
				const passParams = a.passParams ? ' PassParams="1"' : "";
				const winMode = a.winMode !== undefined ? ` WinMode="${a.winMode}"` : "";
				return `<Url Address="${escapeXml(a.address)}"${passParams}${winMode}>
          ${paramsXml}
        </Url>`;
			}
			throw new Error(`Unsupported authored action in ${cmd.id}.`);
		})
		.filter(Boolean)
		.join("\n        ");

	return `<CommandDefinition Id="${escapeXml(cmd.id)}">
      <EnableRules>
        ${enableRulesXml}
      </EnableRules>
      <DisplayRules>
        ${displayRulesXml}
      </DisplayRules>
      <Actions>
        ${actionsXml}
      </Actions>
    </CommandDefinition>`;
}

function generateActionParam(param: ActionParameter): string {
	const nameAttr = param.name ? ` Name="${escapeXml(param.name)}"` : "";
	switch (param.kind) {
		case "CrmParameter":
			return `<CrmParameter${nameAttr} Value="${escapeXml(String(param.value))}"/>`;
		case "BoolParameter":
			return `<BoolParameter${nameAttr} Value="${param.value}"/>`;
		case "IntParameter":
			return `<IntParameter${nameAttr} Value="${param.value}"/>`;
		case "DecimalParameter":
			return `<DecimalParameter${nameAttr} Value="${param.value}"/>`;
		case "StringParameter":
			return `<StringParameter${nameAttr} Value="${escapeXml(String(param.value))}"/>`;
	}
}

// ---------------------------------------------------------------------------
// Rule generators
// ---------------------------------------------------------------------------

function generateEnableRule(rule: EnableRule, baseline?: EnableRule): string {
	if (rule.sourceXml) return rewriteRuleSource(rule.sourceXml, "EnableRule", rule.id, rule.steps, baseline?.steps);
	const steps = rule.steps.map(generateRuleStep).join("\n        ");
	return `<EnableRule Id="${escapeXml(rule.id)}">
        ${steps}
      </EnableRule>`;
}

function generateDisplayRule(rule: DisplayRule, baseline?: DisplayRule): string {
	if (rule.sourceXml) return rewriteRuleSource(rule.sourceXml, "DisplayRule", rule.id, rule.steps, baseline?.steps);
	const steps = rule.steps.map(generateRuleStep).join("\n        ");
	return `<DisplayRule Id="${escapeXml(rule.id)}">
        ${steps}
      </DisplayRule>`;
}

function rewriteRuleSource(sourceXml: string, tagName: string, id: string, steps: RuleStep[], baselineSteps?: RuleStep[]): string {
	const original = parseSourceElement(sourceXml, tagName, id);
	if (baselineSteps && sameModel(steps, baselineSteps)) return new XMLSerializer().serializeToString(original);
	// A parser may have skipped extension rule kinds. An edit to this rule
	// cannot safely replace those children with an incomplete supported model.
	const parsedKindNames = new Set([
		"SelectionCountRule", "EntityRule", "FormStateRule", "CommandClientTypeRule", "CrmClientTypeRule", "CustomRule", "OrRule",
		"MiscellaneousPrivilegeRule", "FormTypeRule", "ValueRule", "SkuRule", "HideForTabletExperienceRule", "OrganizationSettingRule",
		"EntityPrivilegeRule", "EntityPropertyRule", "DeviceTypeRule", "RelationshipTypeRule", "RecordPrivilegeRule", "FormEntityContextRule",
		"PageRule", "ShowOnQuickActionRule", "ShowOnGridAndQuickActionRule", "ShowOnGridRule", "ReferencingAttributeRequiredRule",
		"OutlookItemTrackingRule", "OutlookRenderTypeRule", "OutlookVersionRule", "CrmOfflineAccessStateRule",
		"CrmOutlookClientTypeRule", "CrmOutlookClientVersionRule", "OptionSetRule",
	]);
	if ([...original.children].some(e => !parsedKindNames.has(e.tagName))) {
		throw new Error(`Unsafe partial rewrite of ${id}: unknown rule XML would be removed.`);
	}
	const canonical = new DOMParser().parseFromString(`<Rule>${(baselineSteps ?? steps).map(generateRuleStep).join("")}</Rule>`, "application/xml");
	if (canonical.querySelector("parsererror")) throw new Error(`Cannot validate source rule ${id}.`);
	const validateModeledElement = (actual: Element, expected: Element | undefined): void => {
		if (!expected || actual.tagName !== expected.tagName ||
			[...actual.attributes].some(attribute => !expected.hasAttribute(attribute.name))) {
			throw new Error(`Unsafe partial rewrite of ${id}: unknown rule attributes or nodes would be removed.`);
		}
		const actualChildren = [...actual.children];
		const expectedChildren = [...expected.children];
		if (actualChildren.length !== expectedChildren.length) {
			throw new Error(`Unsafe partial rewrite of ${id}: nested rule XML differs from the editable model.`);
		}
		actualChildren.forEach((child, index) => validateModeledElement(child, expectedChildren[index]));
	};
	const existingSteps = [...original.children];
	const modeledSteps = [...canonical.documentElement.children];
	if (existingSteps.length !== modeledSteps.length) {
		throw new Error(`Unsafe partial rewrite of ${id}: parsed rule definition omitted unknown steps.`);
	}
	existingSteps.forEach((child, index) => validateModeledElement(child, modeledSteps[index]));
	const doc = new DOMParser().parseFromString(`<Rule>${steps.map(generateRuleStep).join("")}</Rule>`, "application/xml");
	if (doc.querySelector("parsererror")) throw new Error(`Cannot serialize edited rule ${id}.`);
	for (const child of [...original.children]) original.removeChild(child);
	for (const child of [...doc.documentElement.children]) original.appendChild(original.ownerDocument.importNode(child, true));
	return new XMLSerializer().serializeToString(original);
}

function generateRuleStep(step: RuleStep): string {
	const invert = "invertResult" in step && step.invertResult ? ' InvertResult="1"' : "";

	switch (step.kind) {
		case "SelectionCountRule": {
			const min = step.minimum !== undefined ? ` Minimum="${step.minimum}"` : "";
			const max = step.maximum !== undefined ? ` Maximum="${step.maximum}"` : "";
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<SelectionCountRule${min}${max}${applies}${invert}/>`;
		}
		case "EntityRule": {
			const entity = step.entityName ? ` EntityName="${escapeXml(step.entityName)}"` : "";
			const ctx = step.context ? ` Context="${step.context}"` : "";
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<EntityRule${entity}${ctx}${applies}${invert}/>`;
		}
		case "FormStateRule":
			return `<FormStateRule State="${step.state}"${invert}/>`;
		case "CommandClientTypeRule": {
			const def = step.default !== undefined ? ` Default="${step.default}"` : "";
			return `<CommandClientTypeRule Type="${step.type}"${def}${invert}/>`;
		}
		case "CrmClientTypeRule":
			return `<CrmClientTypeRule Type="${step.type}"${invert}/>`;
		case "CustomRule": {
			const def = step.default !== undefined ? ` Default="${step.default}"` : "";
			return `<CustomRule Library="${escapeXml(step.library)}" FunctionName="${escapeXml(step.functionName)}"${def}${invert}/>`;
		}
		case "OrRule": {
			const nested = step.rules.map((r) => `<Or>${generateRuleStep(r)}</Or>`).join("\n          ");
			return `<OrRule>\n          ${nested}\n        </OrRule>`;
		}
		case "MiscellaneousPrivilegeRule": {
			const depth = step.privilegeDepth ? ` PrivilegeDepth="${step.privilegeDepth}"` : "";
			return `<MiscellaneousPrivilegeRule PrivilegeName="${escapeXml(step.privilegeName)}"${depth}${invert}/>`;
		}
		case "FormTypeRule":
			return `<FormTypeRule Type="${step.type}"${invert}/>`;
		case "ValueRule":
			return `<ValueRule Field="${escapeXml(step.field)}" Value="${escapeXml(step.value)}"${invert}/>`;
		case "SkuRule":
			return `<SkuRule Sku="${step.sku}"${invert}/>`;
		case "HideForTabletExperienceRule":
			return `<HideForTabletExperienceRule${invert}/>`;
		case "OrganizationSettingRule":
			return `<OrganizationSettingRule Setting="${step.setting}"${invert}/>`;
		case "EntityPrivilegeRule": {
			const entity = step.entityName ? ` EntityName="${escapeXml(step.entityName)}"` : "";
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<EntityPrivilegeRule${entity}${applies} PrivilegeType="${step.privilegeType}" PrivilegeDepth="${step.privilegeDepth}"${invert}/>`;
		}
		case "EntityPropertyRule": {
			const entity = step.entityName ? ` EntityName="${escapeXml(step.entityName)}"` : "";
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<EntityPropertyRule${entity}${applies} PropertyName="${step.propertyName}" PropertyValue="${step.propertyValue}"${invert}/>`;
		}
		case "DeviceTypeRule":
			return `<DeviceTypeRule Type="${step.type}"${invert}/>`;
		case "RelationshipTypeRule": {
			const relType = step.relationshipType ? ` RelationshipType="${step.relationshipType}"` : "";
			const custom =
				step.allowCustomRelationship !== undefined
					? ` AllowCustomRelationship="${step.allowCustomRelationship}"`
					: "";
			const system =
				step.allowSystemRelationship !== undefined
					? ` AllowSystemRelationship="${step.allowSystemRelationship}"`
					: "";
			return `<RelationshipTypeRule AppliesTo="${step.appliesTo}"${relType}${custom}${system}${invert}/>`;
		}
		case "RecordPrivilegeRule": {
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<RecordPrivilegeRule PrivilegeType="${step.privilegeType}"${applies}${invert}/>`;
		}
		case "FormEntityContextRule":
			return `<FormEntityContextRule EntityName="${escapeXml(step.entityName)}"${invert}/>`;
		case "PageRule":
			return `<PageRule Address="${escapeXml(step.address)}"${invert}/>`;
		case "ShowOnQuickActionRule":
			return `<ShowOnQuickActionRule/>`;
		case "ShowOnGridAndQuickActionRule":
			return `<ShowOnGridAndQuickActionRule/>`;
		case "ShowOnGridRule":
			return `<ShowOnGridRule/>`;
		case "ReferencingAttributeRequiredRule":
			return `<ReferencingAttributeRequiredRule${invert}/>`;
		case "OutlookItemTrackingRule": {
			const applies = step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "";
			return `<OutlookItemTrackingRule TrackedInCrm="${step.trackedInCrm}"${applies}${invert}/>`;
		}
		case "OutlookRenderTypeRule":
			return `<OutlookRenderTypeRule Type="${step.type}"${invert}/>`;
		case "OutlookVersionRule":
			return `<OutlookVersionRule Version="${step.version}"${invert}/>`;
		case "CrmOfflineAccessStateRule":
			return `<CrmOfflineAccessStateRule State="${step.state}"${invert}/>`;
		case "CrmOutlookClientTypeRule":
			return `<CrmOutlookClientTypeRule Type="${step.type}"${invert}/>`;
		case "CrmOutlookClientVersionRule": {
			const minor = step.minor !== undefined ? ` Minor="${step.minor}"` : "";
			const build = step.build !== undefined ? ` Build="${step.build}"` : "";
			const revision = step.revision !== undefined ? ` Revision="${step.revision}"` : "";
			return `<CrmOutlookClientVersionRule Major="${step.major}"${minor}${build}${revision}${invert}/>`;
		}
		case "OptionSetRule":
			return `<OptionSetRule OptionSet="${escapeXml(step.optionSet)}" StateCode="${escapeXml(step.stateCode)}" ObjectTypeCode="${escapeXml(step.objectTypeCode)}"${invert}/>`;
		default:
			return `<!-- Unknown rule kind -->`;
	}
}

// ---------------------------------------------------------------------------
// LocLabel generators
// ---------------------------------------------------------------------------

function generateLocLabel(label: LocLabel): string {
	if (label.sourceXml) {
		const original = parseSourceElement(label.sourceXml, "LocLabel", label.id);
		let titles = original.querySelector(":scope > Titles");
		if (!titles) {
			titles = original.ownerDocument.createElement("Titles");
			original.appendChild(titles);
		}
		const seen = new Set<number>();
		const existing = [...titles.querySelectorAll(":scope > Title")];
		for (const current of label.titles) {
			if (seen.has(current.languageCode)) throw new Error(`Duplicate language ${current.languageCode} for LocLabel ${label.id}.`);
			seen.add(current.languageCode);
			const child = existing.find(el => Number(el.getAttribute("languagecode")) === current.languageCode);
			const target = child ?? original.ownerDocument.createElement("Title");
			target.setAttribute("languagecode", String(current.languageCode));
			target.setAttribute("description", current.description);
			if (!child) titles.appendChild(target);
		}
		for (const prior of existing) {
			if (!seen.has(Number(prior.getAttribute("languagecode")))) titles.removeChild(prior);
		}
		return new XMLSerializer().serializeToString(original);
	}
	const titles = label.titles
		.map(
			(t) => `<Title languagecode="${t.languageCode}" description="${escapeXml(t.description)}"/>`,
		)
		.join("\n        ");
	return `<LocLabel Id="${escapeXml(label.id)}">
      <Titles>
        ${titles}
      </Titles>
    </LocLabel>`;
}

function generateTabDisplayRulesForTab(tab: import("@/types/ribbon").RibbonTab): string {
	return tab.tabDisplayRules
		.map((tdr) => {
			const stepsXml = tdr.rules
				.map((step) => {
					if (step.kind === "EntityRule") {
						const attrs = [
							step.appliesTo ? ` AppliesTo="${step.appliesTo}"` : "",
							step.entityName ? ` EntityName="${escapeXml(step.entityName)}"` : "",
							step.context ? ` Context="${step.context}"` : "",
						].join("");
						return `<EntityRule${attrs}/>`;
					}
					if (step.kind === "PageRule") {
						return `<PageRule Address="${escapeXml(step.address)}"/>`;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n          ");
			if (tdr.sourceXml) {
				const original = parseSourceElement(tdr.sourceXml, "TabDisplayRule", tdr.tabCommand);
				const existing = original.querySelector(":scope > DisplayRules");
				const direct = [...original.children].filter(child => child.tagName !== "DisplayRules");
				const originalSteps = existing ? [...existing.children] : direct;
				if (originalSteps.length) {
					for (const rule of originalSteps) {
						const allowed = rule.tagName === "EntityRule"
							? new Set(["AppliesTo", "EntityName", "Context"])
							: rule.tagName === "PageRule" ? new Set(["Address"]) : null;
						if (!allowed || [...rule.attributes].some(attr => !allowed.has(attr.name)) || rule.children.length > 0) {
							throw new Error(`Unsafe partial rewrite of tab display rules ${tdr.tabCommand}: unknown rule content would be lost.`);
						}
					}
				}
				const next = new DOMParser().parseFromString(`<DisplayRules>${stepsXml}</DisplayRules>`, "application/xml");
				if (next.querySelector("parsererror")) throw new Error(`Cannot serialize tab display rule ${tdr.tabCommand}.`);
				if (existing) {
					for (const child of [...existing.children]) existing.removeChild(child);
					for (const child of [...next.documentElement.children]) existing.appendChild(original.ownerDocument.importNode(child, true));
				} else if (direct.length) {
					// CRM ribbon exports also use direct EntityRule/PageRule children.
					// Preserve the original schema layout and remove superseded rules.
					for (const child of direct) original.removeChild(child);
					for (const child of [...next.documentElement.children]) original.appendChild(original.ownerDocument.importNode(child, true));
				} else {
					original.appendChild(original.ownerDocument.importNode(next.documentElement, true));
				}
				return new XMLSerializer().serializeToString(original);
			}
			return `<TabDisplayRule TabCommand="${escapeXml(tdr.tabCommand)}">
        <DisplayRules>
          ${stepsXml}
        </DisplayRules>
      </TabDisplayRule>`;
		})
		.join("\n      ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escapes special XML characters. & must always be escaped first.
 */
export function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Wraps RibbonDiffXml into a full customizations.xml for solution import.
 */
export function wrapInCustomizationsXml(
	ribbonDiffXml: string,
	entityLogicalName: string | null,
	scope: "entity" | "application" | "form",
	formId?: string,
): string {
	const entityBlock = entityLogicalName
		? `
  <Entities>
	    <Entity unmodified="0">
	      <Name>${escapeXml(entityLogicalName)}</Name>
      ${scope === "entity" ? ribbonDiffXml : ""}
      ${scope === "form" && formId
			? `
      <FormXml>
        <forms>
          <systemform formid="${escapeXml(formId)}">
            <form>${ribbonDiffXml}</form>
          </systemform>
        </forms>
      </FormXml>`
			: ""
		}
    </Entity>
  </Entities>`
		: "";

	return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="9.1.0.0">
  ${scope === "application" ? ribbonDiffXml : ""}
  ${entityBlock}
</ImportExportXml>`;
}
