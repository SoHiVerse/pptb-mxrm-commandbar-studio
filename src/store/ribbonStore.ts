import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { draftPublisherIdentity } from "@/utils/draftSource";
import { rebasePendingWorkspace } from "@/services/ribbonSourceRebase";
import type { RibbonDefinitions, RibbonDraft, RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";
import type {
	RibbonLocation,
	RibbonDefinition,
	RibbonButton,
	RibbonGroup,
	RibbonTab,
	CommandDefinition,
	DisplayRule,
	EnableRule,
	LocLabel,
	GroupTemplate,
	ConflictEntry,
	TabDisplayRule,
	ScalingDefinition,
} from "@/types/ribbon";

export interface HistoryEntry {
	ts: string;
	userId: string;
	userName: string;
	op: string;
	target: string;
	detail: string;
	icon: string;
	color: "success" | "warn" | "info" | "danger";
	snapshot: RibbonStoreState;
}

export type RibbonStoreState = {
	ribbons: Record<RibbonLocation, RibbonDefinition>;
	baseline: Record<RibbonLocation, RibbonDefinition>;
	baselineDefinitions: RibbonDefinitions;
	sourceSnapshot: RibbonSourceSnapshot | null;
	workspaceGeneration: number;
	workspaceReadOnly: boolean;
	commands: CommandDefinition[];
	displayRules: DisplayRule[];
	enableRules: EnableRule[];
	locLabels: LocLabel[];
	templates: GroupTemplate[];
	conflicts: ConflictEntry[];
	mutationsSincePublish: number;
	past: HistoryEntry[];
	future: HistoryEntry[];
};

export interface RibbonWorkspaceSeed {
	ribbons: Record<RibbonLocation, RibbonDefinition>;
	commands: CommandDefinition[];
	displayRules: DisplayRule[];
	enableRules: EnableRule[];
	locLabels: LocLabel[];
	templates?: GroupTemplate[];
	conflicts?: ConflictEntry[];
	sourceSnapshot?: RibbonSourceSnapshot | null;
}

type DragSource = { groupId: string; buttonId: string; tabId: string; location: RibbonLocation };
type DragTarget = {
	groupId: string;
	beforeButtonId?: string;
	tabId: string;
	location: RibbonLocation;
};

type NewButtonContext = {
	tabId: string;
	groupId: string;
	location: RibbonLocation;
	button: Omit<RibbonButton, "id"> & { id?: string };
};

type NewGroupContext = {
	tabId: string;
	location: RibbonLocation;
	group: Omit<RibbonGroup, "id"> & { id?: string };
};

export interface RibbonStore extends RibbonStoreState {
	// History actions
	undo(): void;
	redo(): void;
	restore(index: number): void;

	// Mutations
	moveButton(src: DragSource, dst: DragTarget): void;
	setButtonProp(
		location: RibbonLocation,
		tabId: string,
		groupId: string,
		buttonId: string,
		patch: Partial<RibbonButton>,
	): void;
	deleteButton(location: RibbonLocation, tabId: string, groupId: string, buttonId: string): void;
	duplicateButton(location: RibbonLocation, tabId: string, groupId: string, buttonId: string): void;
	createButton(ctx: NewButtonContext): void;
	createGroup(ctx: NewGroupContext): void;
	renameGroup(location: RibbonLocation, tabId: string, groupId: string, newLabel: string): void;
	duplicateGroup(location: RibbonLocation, tabId: string, groupId: string): void;
	setGroupTemplate(
		location: RibbonLocation,
		tabId: string,
		groupId: string,
		template: string,
	): void;
	deleteGroup(location: RibbonLocation, tabId: string, groupId: string): void;
	createTab(location: RibbonLocation, tabDef: Partial<RibbonTab>): void;
	renameTab(location: RibbonLocation, tabId: string, newLabel: string): void;
	deleteTab(location: RibbonLocation, tabId: string): void;
	reorderTabs(location: RibbonLocation, tabIds: string[]): void;
	setTabDisplayRules(location: RibbonLocation, tabId: string, rules: TabDisplayRule[]): void;
	setScaling(location: RibbonLocation, tabId: string, scaling: ScalingDefinition): void;
	hideOobButton(location: RibbonLocation, tabId: string, groupId: string, buttonId: string): void;
	customizeOobButton(
		location: RibbonLocation,
		tabId: string,
		groupId: string,
		buttonId: string,
	): void;
	upsertCommand(cmd: CommandDefinition): void;
	renameCommandId(oldId: string, newId: string): boolean;
	upsertDisplayRule(rule: DisplayRule): void;
	renameDisplayRuleId(oldId: string, newId: string): boolean;
	upsertEnableRule(rule: EnableRule): void;
	renameEnableRuleId(oldId: string, newId: string): boolean;
	upsertLocLabel(label: LocLabel): void;
	markPublished(published?: RibbonWorkspace, sourceSnapshot?: RibbonSourceSnapshot, expectedGeneration?: number, submittedWorkspace?: RibbonWorkspace): void;
	restoreDraft(draft: RibbonDraft): void;
	applyWorkspaceEdit(workspace: RibbonWorkspace, description: string): void;
	setConflicts(entries: ConflictEntry[]): void;

	// Load initial data
	loadRibbons(ribbons: Record<RibbonLocation, RibbonDefinition>): void;
	loadWorkspace(seed: RibbonWorkspaceSeed): void;
	clearWorkspace(): void;
}

const MAX_HISTORY = 80;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function getEditableWorkspace(state: RibbonStoreState): RibbonWorkspace {
	return {
		ribbons: state.ribbons,
		commands: state.commands,
		displayRules: state.displayRules,
		enableRules: state.enableRules,
		locLabels: state.locLabels,
	};
}

export function getBaselineWorkspace(state: RibbonStoreState): RibbonWorkspace {
	return { ribbons: state.baseline, ...state.baselineDefinitions };
}

function getDefinitions(seed: RibbonDefinitions): RibbonDefinitions {
	return clone({ commands: seed.commands, displayRules: seed.displayRules, enableRules: seed.enableRules, locLabels: seed.locLabels });
}

function sameWorkspace(left: RibbonWorkspace, right: RibbonWorkspace): boolean {
	// Callers may construct the top-level object in a different property order.
	const values = (value: RibbonWorkspace) => [value.ribbons, value.commands, value.displayRules, value.enableRules, value.locLabels];
	return JSON.stringify(values(left)) === JSON.stringify(values(right));
}

function dirtyCount(state: RibbonStoreState, workspace: RibbonWorkspace, proposed: number): number {
	return sameWorkspace(workspace, getBaselineWorkspace(state)) ? 0 : Math.max(1, proposed);
}

function sameSourceIdentity(left: RibbonSourceSnapshot, right: RibbonSourceSnapshot): boolean {
	return left.solutionUniqueName === right.solutionUniqueName &&
		left.entityLogicalName === right.entityLogicalName &&
		left.organizationUrl === right.organizationUrl && left.userId === right.userId;
}

function commitDefinitions(
	state: RibbonStoreState,
	patch: Partial<RibbonDefinitions>,
	target: string,
): Partial<RibbonStoreState> {
	assertWorkspaceEditable(state);
	const next = { ...getEditableWorkspace(state), ...clone(patch) };
	if (sameWorkspace(next, getEditableWorkspace(state))) return {};
	const entry: HistoryEntry = {
		ts: new Date().toISOString(), userId: "", userName: "You", op: "edited", target,
		detail: Object.keys(patch).join(", "), icon: "edit", color: "info", snapshot: { ...state },
	};
	return {
		...clone(patch), past: [...state.past, entry].slice(-MAX_HISTORY), future: [],
		mutationsSincePublish: dirtyCount(state, next, state.mutationsSincePublish + 1)
	};
}

function cloneRibbons(
	ribbons: Record<RibbonLocation, RibbonDefinition>,
): Record<RibbonLocation, RibbonDefinition> {
	return JSON.parse(JSON.stringify(ribbons));
}

function commitMutation(
	state: RibbonStoreState,
	mutator: (ribbons: Record<RibbonLocation, RibbonDefinition>) => void,
	meta: Omit<HistoryEntry, "snapshot">,
): Partial<RibbonStoreState> {
	assertWorkspaceEditable(state);
	const next = cloneRibbons(state.ribbons);
	mutator(next);
	if (JSON.stringify(next) === JSON.stringify(state.ribbons)) return {};
	const entry: HistoryEntry = { ...meta, snapshot: { ...state } };
	const past = [...state.past, entry].slice(-MAX_HISTORY);
	return {
		ribbons: next,
		past,
		future: [],
		mutationsSincePublish: dirtyCount(state, { ...getEditableWorkspace(state), ribbons: next }, state.mutationsSincePublish + 1),
	};
}

function assertWorkspaceEditable(state: RibbonStoreState): void {
	if (state.workspaceReadOnly) throw new Error("This workspace is read-only until its unmanaged source can be loaded. Retry the source export before editing.");
}

const EMPTY_RIBBONS: Record<RibbonLocation, RibbonDefinition> = {
	HomepageGrid: { location: "HomepageGrid", entityLogicalName: "", tabs: [] },
	SubGrid: { location: "SubGrid", entityLogicalName: "", tabs: [] },
	Form: { location: "Form", entityLogicalName: "", tabs: [] },
	Application: { location: "Application", entityLogicalName: "", tabs: [] },
};

function isReadOnlyGlobalOobButton(
	location: RibbonLocation,
	tabId: string,
	button: RibbonButton,
): boolean {
	return (
		location === "Application" &&
		tabId === "Mscrm.GlobalTab" &&
		button.oob === true &&
		button.custom !== true
	);
}

export const useRibbonStore = create<RibbonStore>()(
	subscribeWithSelector((set, get) => ({
		ribbons: cloneRibbons(EMPTY_RIBBONS),
		baseline: cloneRibbons(EMPTY_RIBBONS),
		baselineDefinitions: { commands: [], displayRules: [], enableRules: [], locLabels: [] },
		sourceSnapshot: null,
		workspaceGeneration: 0,
		workspaceReadOnly: true,
		commands: [],
		displayRules: [],
		enableRules: [],
		locLabels: [],
		templates: [],
		conflicts: [],
		mutationsSincePublish: 0,
		past: [],
		future: [],

		loadRibbons(ribbons) {
			set({
				workspaceGeneration: get().workspaceGeneration + 1,
				workspaceReadOnly: false,
				ribbons: cloneRibbons(ribbons),
				baseline: cloneRibbons(ribbons),
				baselineDefinitions: getDefinitions(get()),
				sourceSnapshot: null,
				mutationsSincePublish: 0,
				past: [],
				future: [],
			});
		},

		setConflicts(entries) {
			set({ conflicts: entries });
		},

		loadWorkspace(seed) {
			const ribbons = cloneRibbons(seed.ribbons);
			set({
				workspaceGeneration: get().workspaceGeneration + 1,
					// Source availability governs server publication, not the original
					// client-side editor. An empty/unselected workspace remains guarded.
					workspaceReadOnly: !ribbons.Form.entityLogicalName,
				ribbons,
				baseline: cloneRibbons(ribbons),
				...getDefinitions(seed),
				baselineDefinitions: getDefinitions(seed),
				sourceSnapshot: seed.sourceSnapshot ? clone(seed.sourceSnapshot) : null,
				templates: [...(seed.templates ?? [])],
				conflicts: [...(seed.conflicts ?? [])],
				mutationsSincePublish: 0,
				past: [],
				future: [],
			});
		},

		undo() {
			const state = get();
			assertWorkspaceEditable(state);
			const { past, future } = state;
			if (past.length === 0) return;
			const entry = past[past.length - 1];
			const editable = clone(getEditableWorkspace(entry.snapshot));
			set({
				...editable,
				past: past.slice(0, -1),
				future: [{ ...entry, snapshot: { ...state } }, ...future],
				mutationsSincePublish: dirtyCount(state, editable, state.mutationsSincePublish - 1),
			});
		},

		redo() {
			const state = get();
			assertWorkspaceEditable(state);
			const { future } = state;
			if (future.length === 0) return;
			const [entry, ...rest] = future;
			const editable = clone(getEditableWorkspace(entry.snapshot));
			set({
				...editable,
				past: [...state.past, { ...entry, snapshot: { ...state } }].slice(-MAX_HISTORY),
				future: rest,
				mutationsSincePublish: dirtyCount(state, editable, state.mutationsSincePublish + 1),
			});
		},

		restore(index) {
			assertWorkspaceEditable(get());
			const { past } = get();
			if (index < 0 || index >= past.length) return;
			const target = past[index];
			const currentSnapshot: RibbonStoreState = {
				ribbons: cloneRibbons(get().ribbons),
				baseline: cloneRibbons(get().baseline),
				baselineDefinitions: getDefinitions(get().baselineDefinitions),
				sourceSnapshot: get().sourceSnapshot,
				workspaceGeneration: get().workspaceGeneration,
				workspaceReadOnly: get().workspaceReadOnly,
				commands: [...get().commands],
				displayRules: [...get().displayRules],
				enableRules: [...get().enableRules],
				locLabels: [...get().locLabels],
				templates: [...get().templates],
				conflicts: [...get().conflicts],
				mutationsSincePublish: get().mutationsSincePublish,
				past: [...get().past],
				future: [...get().future],
			};

			set({
				ribbons: cloneRibbons(target.snapshot.ribbons),
				commands: [...target.snapshot.commands],
				displayRules: [...target.snapshot.displayRules],
				enableRules: [...target.snapshot.enableRules],
				locLabels: [...target.snapshot.locLabels],
				templates: [...target.snapshot.templates],
				conflicts: [...target.snapshot.conflicts],
				mutationsSincePublish: dirtyCount(get(), getEditableWorkspace(target.snapshot), get().mutationsSincePublish + 1),
				past: past.slice(0, index + 1),
				future: [
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "restored",
						target: target.target,
						detail: "from history",
						icon: "clock_arrow_counterclockwise",
						color: "info",
						snapshot: currentSnapshot,
					},
					...get().future,
				],
			});
		},

		moveButton(src, dst) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[src.location].tabs.find((t) => t.id === src.tabId);
						if (!tab) return;
						const srcGroup = tab.groups.find((g) => g.id === src.groupId);
						if (!srcGroup) return;
						const btnIdx = srcGroup.buttons.findIndex((b) => b.id === src.buttonId);
						if (btnIdx === -1) return;
						if (isReadOnlyGlobalOobButton(src.location, src.tabId, srcGroup.buttons[btnIdx]))
							return;
						const dstTab =
							src.tabId === dst.tabId && src.location === dst.location
								? tab
								: ribbons[dst.location].tabs.find((t) => t.id === dst.tabId);
						if (!dstTab) return;
						const dstGroup = dstTab.groups.find((g) => g.id === dst.groupId);
						if (!dstGroup) return;
						if (src.location === dst.location && src.groupId === dst.groupId && dst.beforeButtonId === src.buttonId) return;
						const [button] = srcGroup.buttons.splice(btnIdx, 1);
						const insertIdx = dst.beforeButtonId
							? dstGroup.buttons.findIndex((b) => b.id === dst.beforeButtonId)
							: dstGroup.buttons.length;
						dstGroup.buttons.splice(insertIdx < 0 ? dstGroup.buttons.length : insertIdx, 0, button);
						// Sequence is part of the persisted ribbon, unlike the UI array order.
						dstGroup.buttons.forEach((item, index) => { item.sequence = (index + 1) * 10; });
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "moved",
						target: src.buttonId,
						detail: `to ${dst.groupId}`,
						icon: "arrow_move",
						color: "info",
					},
				),
			);
		},

		setButtonProp(location, tabId, groupId, buttonId, patch) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						const button = group?.buttons.find((b) => b.id === buttonId);
						if (!button) return;
						if (isReadOnlyGlobalOobButton(location, tabId, button)) return;
						Object.assign(button, patch);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "edited",
						target: patch.label ?? buttonId,
						detail: Object.keys(patch).join(", "),
						icon: "edit",
						color: "info",
					},
				),
			);
		},

		deleteButton(location, tabId, groupId, buttonId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						if (!group) return;
						const button = group.buttons.find((b) => b.id === buttonId);
						if (!button) return;
						if (isReadOnlyGlobalOobButton(location, tabId, button)) return;
						group.buttons = group.buttons.filter((b) => b.id !== buttonId);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "deleted",
						target: buttonId,
						detail: groupId,
						icon: "delete",
						color: "danger",
					},
				),
			);
		},

		duplicateButton(location, tabId, groupId, buttonId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						const btn = group?.buttons.find((b) => b.id === buttonId);
						if (btn && group) {
							if (isReadOnlyGlobalOobButton(location, tabId, btn)) return;
							const copy: RibbonButton = {
								...btn,
								id: `${btn.id}_copy_${Date.now()}`,
								label: `${btn.label} (copy)`,
								custom: true,
								oob: false,
								managed: false,
								origin: "unmanaged",
								sequence: btn.sequence + 5,
							};
							const idx = group.buttons.findIndex((b) => b.id === buttonId);
							group.buttons.splice(idx + 1, 0, copy);
						}
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "duplicated",
						target: buttonId,
						detail: groupId,
						icon: "copy",
						color: "info",
					},
				),
			);
		},

		createButton({ tabId, groupId, location, button }) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						if (group) {
							const newBtn: RibbonButton = {
								...button,
								id: button.id ?? `new_${Date.now()}`,
								label: button.label ?? "New Button",
								kind: button.kind ?? "button",
								sequence: button.sequence ?? (group.buttons.length + 1) * 10,
								templateAlias: button.templateAlias ?? "o1",
								commandId: button.commandId ?? "",
								hidden: button.hidden ?? false,
								oob: false,
								custom: true,
								managed: false,
								origin: "unmanaged",
							};
							group.buttons.push(newBtn);
						}
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "added",
						target: button.label ?? "New Button",
						detail: groupId,
						icon: "add",
						color: "success",
					},
				),
			);
		},

		createGroup({ tabId, location, group }) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						if (tab) {
							const newGroup: RibbonGroup = {
								id: group.id ?? `grp_${Date.now()}`,
								label: group.label ?? "New Group",
								sequence: group.sequence ?? (tab.groups.length + 1) * 10,
								template: group.template ?? "Flexible2",
								buttons: group.buttons ?? [],
							};
							tab.groups.push(newGroup);
						}
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "added",
						target: group.label ?? "New Group",
						detail: tabId,
						icon: "add",
						color: "success",
					},
				),
			);
		},

		renameGroup(location, tabId, groupId, newLabel) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						if (group) group.label = newLabel;
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "renamed",
						target: groupId,
						detail: newLabel,
						icon: "edit",
						color: "info",
					},
				),
			);
		},

		duplicateGroup(location, tabId, groupId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						if (!tab) return;
						const grp = tab.groups.find((g) => g.id === groupId);
						if (!grp) return;
						const stamp = `_copy_${Date.now()}`;
						const copy: RibbonGroup = {
							...JSON.parse(JSON.stringify(grp)),
							id: `${grp.id}${stamp}`,
							label: `${grp.label} (copy)`,
							sequence: grp.sequence + 5,
							buttons: grp.buttons.map((b) => ({
								...b,
								id: `${b.id}${stamp}`,
								custom: true,
								oob: false,
								managed: false,
								origin: "unmanaged" as const,
							})),
						};
						const idx = tab.groups.findIndex((g) => g.id === groupId);
						tab.groups.splice(idx + 1, 0, copy);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "duplicated",
						target: groupId,
						detail: tabId,
						icon: "copy",
						color: "info",
					},
				),
			);
		},

		setGroupTemplate(location, tabId, groupId, template) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						if (group) group.template = template;
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "edited",
						target: groupId,
						detail: `template → ${template}`,
						icon: "edit",
						color: "info",
					},
				),
			);
		},

		deleteGroup(location, tabId, groupId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						if (tab) tab.groups = tab.groups.filter((g) => g.id !== groupId);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "deleted",
						target: groupId,
						detail: tabId,
						icon: "delete",
						color: "danger",
					},
				),
			);
		},

		createTab(location, tabDef) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const ribbon = ribbons[location];
						const newTab: RibbonTab = {
							id: tabDef.id ?? `tab_${Date.now()}`,
							label: tabDef.label ?? "New Tab",
							sequence: tabDef.sequence ?? (ribbon.tabs.length + 1) * 10,
							tabDisplayRules: [],
							groups: [],
						};
						ribbon.tabs.push(newTab);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "added",
						target: tabDef.label ?? "New Tab",
						detail: location,
						icon: "add",
						color: "success",
					},
				),
			);
		},

		renameTab(location, tabId, newLabel) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						if (tab) tab.label = newLabel;
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "renamed",
						target: tabId,
						detail: newLabel,
						icon: "edit",
						color: "info",
					},
				),
			);
		},

		deleteTab(location, tabId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						ribbons[location].tabs = ribbons[location].tabs.filter((t) => t.id !== tabId);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "deleted",
						target: tabId,
						detail: location,
						icon: "delete",
						color: "danger",
					},
				),
			);
		},

		reorderTabs(location, tabIds) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tabs = ribbons[location].tabs;
						ribbons[location].tabs = tabIds
							.map((id) => tabs.find((t) => t.id === id))
							.filter((t): t is RibbonTab => t !== undefined);
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "reordered",
						target: "Tabs",
						detail: location,
						icon: "arrow_sort",
						color: "info",
					},
				),
			);
		},

		setTabDisplayRules(location, tabId, rules) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						if (tab) tab.tabDisplayRules = rules;
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "edited",
						target: `${tabId} display rules`,
						detail: `${rules.length} rule(s)`,
						icon: "eye",
						color: "info",
					},
				),
			);
		},

		setScaling(location, tabId, scaling) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const ribbon = ribbons[location];
						ribbon.scalingByTab = ribbon.scalingByTab ?? {};
						ribbon.scalingByTab[tabId] = {
							tabId,
							maxSizes: [...scaling.maxSizes],
							scales: [...scaling.scales],
						};
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "edited",
						target: `${tabId} scaling`,
						detail: `${scaling.maxSizes.length} MaxSize, ${scaling.scales.length} Scale`,
						icon: "resize",
						color: "info",
					},
				),
			);
		},

		hideOobButton(location, tabId, groupId, buttonId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						const btn = group?.buttons.find((b) => b.id === buttonId);
						if (!btn) return;
						if (isReadOnlyGlobalOobButton(location, tabId, btn)) return;
						btn.hidden = true;
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "hid",
						target: buttonId,
						detail: groupId,
						icon: "eye_off",
						color: "warn",
					},
				),
			);
		},

		customizeOobButton(location, tabId, groupId, buttonId) {
			set((state) =>
				commitMutation(
					state,
					(ribbons) => {
						const tab = ribbons[location].tabs.find((t) => t.id === tabId);
						const group = tab?.groups.find((g) => g.id === groupId);
						const btn = group?.buttons.find((b) => b.id === buttonId);
						if (btn) {
							if (isReadOnlyGlobalOobButton(location, tabId, btn)) return;
							// Creating an override makes this an unmanaged customization
							// layered over the OOB/managed original (same id).
							btn.oob = false;
							btn.custom = true;
							btn.managed = false;
							btn.origin = "unmanaged";
						}
					},
					{
						ts: new Date().toISOString(),
						userId: "",
						userName: "You",
						op: "customized",
						target: buttonId,
						detail: "OOB override",
						icon: "edit",
						color: "info",
					},
				),
			);
		},

		upsertCommand(cmd) {
			set((state) => {
				const existing = state.commands.findIndex((c) => c.id === cmd.id);
				const commands =
					existing >= 0
						? state.commands.map((c, i) => (i === existing ? cmd : c))
						: [...state.commands, cmd];
				return commitDefinitions(state, { commands }, cmd.id);
			});
		},

		renameCommandId(oldId, newId) {
			assertWorkspaceEditable(get());
			const state = get();
			if (!oldId || !newId || oldId === newId) return true;
			if (state.commands.some((c) => c.id === newId)) return false;

			set((current) => {
				const nextRibbons = cloneRibbons(current.ribbons);
				for (const location of Object.keys(nextRibbons) as RibbonLocation[]) {
					for (const tab of nextRibbons[location].tabs) {
						for (const group of tab.groups) {
							for (const button of group.buttons) {
								if (button.commandId === oldId) {
									button.commandId = newId;
								}
							}
						}
					}
				}

				const commands = current.commands.map((c) =>
					c.id === oldId
						? {
							...c,
							id: newId,
						}
						: c,
				);

				const entry: HistoryEntry = {
					ts: new Date().toISOString(),
					userId: "",
					userName: "You",
					op: "renamed",
					target: oldId,
					detail: `command -> ${newId}`,
					icon: "edit",
					color: "info",
					snapshot: { ...current },
				};

				return {
					ribbons: nextRibbons,
					commands,
					past: [...current.past, entry].slice(-MAX_HISTORY),
					future: [],
					mutationsSincePublish: current.mutationsSincePublish + 1,
				};
			});

			return true;
		},

		upsertDisplayRule(rule) {
			set((state) => {
				const existing = state.displayRules.findIndex((r) => r.id === rule.id);
				const displayRules =
					existing >= 0
						? state.displayRules.map((r, i) => (i === existing ? rule : r))
						: [...state.displayRules, rule];
				return commitDefinitions(state, { displayRules }, rule.id);
			});
		},

		renameDisplayRuleId(oldId, newId) {
			assertWorkspaceEditable(get());
			const state = get();
			if (!oldId || !newId || oldId === newId) return true;
			if (state.displayRules.some((r) => r.id === newId)) return false;

			set((current) => {
				const displayRules = current.displayRules.map((r) =>
					r.id === oldId
						? {
							...r,
							id: newId,
						}
						: r,
				);
				const commands = current.commands.map((c) => ({
					...c,
					displayRules: c.displayRules.map((id) => (id === oldId ? newId : id)),
				}));

				const entry: HistoryEntry = {
					ts: new Date().toISOString(),
					userId: "",
					userName: "You",
					op: "renamed",
					target: oldId,
					detail: `display rule -> ${newId}`,
					icon: "edit",
					color: "info",
					snapshot: { ...current },
				};

				return {
					displayRules,
					commands,
					past: [...current.past, entry].slice(-MAX_HISTORY),
					future: [],
					mutationsSincePublish: current.mutationsSincePublish + 1,
				};
			});

			return true;
		},

		upsertEnableRule(rule) {
			set((state) => {
				const existing = state.enableRules.findIndex((r) => r.id === rule.id);
				const enableRules =
					existing >= 0
						? state.enableRules.map((r, i) => (i === existing ? rule : r))
						: [...state.enableRules, rule];
				return commitDefinitions(state, { enableRules }, rule.id);
			});
		},

		renameEnableRuleId(oldId, newId) {
			assertWorkspaceEditable(get());
			const state = get();
			if (!oldId || !newId || oldId === newId) return true;
			if (state.enableRules.some((r) => r.id === newId)) return false;

			set((current) => {
				const enableRules = current.enableRules.map((r) =>
					r.id === oldId
						? {
							...r,
							id: newId,
						}
						: r,
				);
				const commands = current.commands.map((c) => ({
					...c,
					enableRules: c.enableRules.map((id) => (id === oldId ? newId : id)),
				}));

				const entry: HistoryEntry = {
					ts: new Date().toISOString(),
					userId: "",
					userName: "You",
					op: "renamed",
					target: oldId,
					detail: `enable rule -> ${newId}`,
					icon: "edit",
					color: "info",
					snapshot: { ...current },
				};

				return {
					enableRules,
					commands,
					past: [...current.past, entry].slice(-MAX_HISTORY),
					future: [],
					mutationsSincePublish: current.mutationsSincePublish + 1,
				};
			});

			return true;
		},

		upsertLocLabel(label) {
			set((state) => {
				const existing = state.locLabels.findIndex((l) => l.id === label.id);
				const locLabels =
					existing >= 0
						? state.locLabels.map((l, i) => (i === existing ? label : l))
						: [...state.locLabels, label];
				return commitDefinitions(state, { locLabels }, label.id);
			});
		},

		markPublished(published, sourceSnapshot, expectedGeneration, submittedWorkspace) {
			const state = get();
			if (expectedGeneration !== undefined && state.workspaceGeneration !== expectedGeneration) {
				throw new Error("The workspace was reloaded while publication was running. Its new baseline was not changed.");
			}
			if (sourceSnapshot && (!state.sourceSnapshot || !sameSourceIdentity(sourceSnapshot, state.sourceSnapshot))) {
				throw new Error("The workspace changed while publication was running. Reload its verified result separately.");
			}
			const completed = clone(published ?? getEditableWorkspace(state));
			if (completed.ribbons.Form.entityLogicalName !== state.ribbons.Form.entityLogicalName) {
				throw new Error("The selected entity changed while publication was running.");
			}
			const current = submittedWorkspace ? rebasePendingWorkspace(getEditableWorkspace(state), submittedWorkspace, completed) : getEditableWorkspace(state);
			set({
				...current,
				baseline: cloneRibbons(completed.ribbons),
				baselineDefinitions: getDefinitions(completed),
				sourceSnapshot: sourceSnapshot ? clone(sourceSnapshot) : state.sourceSnapshot,
				mutationsSincePublish: sameWorkspace(current, completed) ? 0 : Math.max(1, state.mutationsSincePublish),
			});
		},

		clearWorkspace() {
			get().loadWorkspace({ ribbons: cloneRibbons(EMPTY_RIBBONS), commands: [], displayRules: [], enableRules: [], locLabels: [], sourceSnapshot: null });
		},

		restoreDraft(draft) {
			const state = get();
			assertWorkspaceEditable(state);
			if (draft.version !== 2 || !state.sourceSnapshot || !sameSourceIdentity(draft.sourceSnapshot, state.sourceSnapshot)) {
				throw new Error("The draft does not match this organization, solution and entity workspace.");
			}
			if (draft.sourceSnapshot.solutionVersion !== state.sourceSnapshot.solutionVersion ||
				draftPublisherIdentity(draft.sourceSnapshot.solutionXml) !== draftPublisherIdentity(state.sourceSnapshot.solutionXml)) {
				throw new Error("The solution version or publisher changed since this draft was saved. Reload and reconcile the draft before publishing.");
			}
			// A conservative comparison: differing server XML requires reconciliation, not blind restoration.
			const compact = (xml: string | null) => xml?.replace(/>\s+</g, "><").trim() ?? null;
			if (compact(draft.sourceSnapshot.entityRibbonXml) !== compact(state.sourceSnapshot.entityRibbonXml) ||
				compact(draft.sourceSnapshot.applicationRibbonXml) !== compact(state.sourceSnapshot.applicationRibbonXml) ||
				!sameWorkspace(draft.baseline, getBaselineWorkspace(state))) {
				throw new Error("The server ribbon baseline changed since this draft was saved. Export the draft and reconcile the conflict before publishing.");
			}
			const editable = clone(draft.current);
			if (editable.ribbons.Form.entityLogicalName !== state.ribbons.Form.entityLogicalName) {
				throw new Error("The draft entity does not match the loaded workspace.");
			}
			set({ ...editable, past: [], future: [], mutationsSincePublish: dirtyCount(state, editable, 1) });
		},

		applyWorkspaceEdit(workspace, description) {
			const state = get();
			assertWorkspaceEditable(state);
			for (const location of ["HomepageGrid", "SubGrid", "Form", "Application"] as const) {
				if (workspace.ribbons[location].entityLogicalName !== state.ribbons[location].entityLogicalName) throw new Error("Imported XML does not match the loaded entity workspace.");
			}
			const next = clone(workspace);
			if (sameWorkspace(next, getEditableWorkspace(state))) return;
			const entry: HistoryEntry = { ts: new Date().toISOString(), userId: "", userName: "You", op: "imported", target: "workspace", detail: description, icon: "edit", color: "info", snapshot: { ...state } };
			set({ ...next, past: [...state.past, entry].slice(-MAX_HISTORY), future: [], mutationsSincePublish: dirtyCount(state, next, state.mutationsSincePublish + 1) });
		},
	})),
);
