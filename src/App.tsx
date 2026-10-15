import {
	makeStyles,
	tokens,
	FluentProvider,
	webLightTheme,
	webDarkTheme,
	Tab,
	TabList,
	MessageBar,
	MessageBarBody,
	MessageBarActions,
	Button,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { Layout } from "@/components/shell/Layout";

import { RibbonCanvas } from "@/components/ribbon-canvas/RibbonCanvas";
import { PropertiesPane } from "@/components/properties-pane/PropertiesPane";
import { BottomPanel } from "@/components/bottom-panel/BottomPanel";
import { TablesPane } from "@/components/left-pane/TablesPane";
import { SolutionElementsPane } from "@/components/left-pane/SolutionElementsPane";
import { useSessionStore } from "@/store/sessionStore";
import { useRibbonStore } from "@/store/ribbonStore";
import { useUIStore } from "@/store/uiStore";
import { useSelectionStore } from "@/store/selectionStore";
import {
	fetchSolutions,
	fetchSolutionEntityIds,
	fetchSolutionRibbonComponentIds,
} from "@/services/dataverse/solutionService";
import { fetchEntitiesByMetadataIds } from "@/services/dataverse/entityService";
import { fetchSourceBoundWorkspace } from "@/services/dataverse/workspaceLoadService";
import { fetchRibbonProvenance } from "@/services/dataverse/ribbonProvenanceService";
import { applyProvenanceToRibbons, type ButtonProvenance } from "@/utils/ribbonProvenance";
import type { ConflictEntry } from "@/types/ribbon";
import { fetchCurrentUser } from "@/services/dataverse/userService";
import {
	useRibbonPersistence,
	loadPersistedRibbonData,
	clearPersistedRibbonData,
} from "@/hooks/useRibbonPersistence";
import { useRuntimeLogStore } from "@/store/runtimeLogStore";

const useStyles = makeStyles({
	leftPaneTabs: {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		overflow: "hidden",
	},
	tabList: {
		flexShrink: 0,
		borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
	},
	tabContent: {
		flex: 1,
		overflow: "hidden",
	},
});

function LeftPane() {
	const styles = useStyles();
	const [tab, setTab] = useState<"tables" | "elements">("tables");

	return (
		<div className={styles.leftPaneTabs}>
			<TabList
				className={styles.tabList}
				selectedValue={tab}
				onTabSelect={(_, d) => setTab(d.value as "tables" | "elements")}
				size="small"
			>
				<Tab value="tables">Tables</Tab>
				<Tab value="elements">Solution</Tab>
			</TabList>
			<div className={styles.tabContent}>
				{tab === "tables" ? <TablesPane /> : <SolutionElementsPane />}
			</div>
		</div>
	);
}

export function App() {
	const setSolutions = useSessionStore((s) => s.setSolutions);
	const setEntities = useSessionStore((s) => s.setEntities);
	const setCurrentUser = useSessionStore((s) => s.setCurrentUser);
	const setSolutionEntityIds = useSessionStore((s) => s.setSolutionEntityIds);
	const setSolutionRibbonComponentIds = useSessionStore((s) => s.setSolutionRibbonComponentIds);
	const connectionUrl = useSessionStore((s) => s.connectionUrl);
	const activeSolution = useSessionStore((s) => s.activeSolution);
	const activeEntity = useSessionStore((s) => s.activeEntity);
	const loadWorkspace = useRibbonStore((s) => s.loadWorkspace);
	const clearWorkspace = useRibbonStore((s) => s.clearWorkspace);
	const restoreDraft = useRibbonStore((s) => s.restoreDraft);
	const sourceSnapshot = useRibbonStore((s) => s.sourceSnapshot);
	const mutationsSincePublish = useRibbonStore((s) => s.mutationsSincePublish);
	const setTabId = useSelectionStore((s) => s.setTabId);
	const themeMode = useUIStore((s) => s.themeMode);
	const logInfo = useRuntimeLogStore((s) => s.logInfo);
	const logWarn = useRuntimeLogStore((s) => s.logWarn);
	const logError = useRuntimeLogStore((s) => s.logError);

	// Auto-save ribbon state on every mutation
	useRibbonPersistence();
	useEffect(() => {
		if (mutationsSincePublish === 0) return;
		const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [mutationsSincePublish]);

	// Restore banner state
	const [showRestoreBanner, setShowRestoreBanner] = useState(false);
	const [pendingRestore, setPendingRestore] =
		useState<ReturnType<typeof loadPersistedRibbonData>>(null);
	const [ribbonLoadState, setRibbonLoadState] = useState<"idle" | "loading" | "error">("idle");
	const [ribbonLoadError, setRibbonLoadError] = useState<string | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [reloadVersion, setReloadVersion] = useState(0);

	// ----- Initial bootstrap: solutions + current user only -----
	// Entities are deferred until the user picks a solution. Ribbon Workbench's
	// convention (and what MS doc `export-prepare-edit-import-ribbon` shows) is
	// that an entity must be a component of the unmanaged solution before its
	// ribbon can be exported, edited, and re-imported. CBS now enforces the
	// same workflow up-front.
	useEffect(() => {
		logInfo("runtime", "Loading solutions and current user...");

		fetchSolutions()
			.then((sols) => {
				setSolutions(sols);
				logInfo("runtime", `Loaded ${sols.length} solution(s). Pick one to load its tables.`);
			})
			.catch((error) => {
				logError(
					"runtime",
					`Failed to load solutions: ${error instanceof Error ? error.message : String(error)}`,
				);
			});

		void fetchCurrentUser()
			.then((user) => {
				if (!user.id) return;
				setCurrentUser(user.id, user.name);
				logInfo("runtime", `Current user: ${user.name}.`);
			})
			.catch((error) => {
				logWarn(
					"runtime",
					`Failed to resolve current user: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}, [setSolutions, setCurrentUser, logInfo, logWarn, logError]);

	// ----- When the user picks a solution: resolve its entity components and
	// fetch metadata for ONLY those entities (no bulk 1883-row catalog load).
	// This matches Ribbon Workbench's behavior and is more reliable than
	// PPTB's `getAllEntitiesMetadata` (which was silently dropping entities,
	// likely due to OData paging not being followed).
	useEffect(() => {
		if (!activeSolution) {
			setSolutionEntityIds(null);
			setSolutionRibbonComponentIds(null);
			setEntities([]);
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				// Fetch both component sets in parallel — entity components for
				// the table picker, ribbon-customization components (type=50)
				// so the publish dialog can correctly enable / declare the
				// application-ribbon publish path.
				const [entityIds, ribbonIds] = await Promise.all([
					fetchSolutionEntityIds(activeSolution.id),
					fetchSolutionRibbonComponentIds(activeSolution.id).catch((error) => {
						logWarn("runtime", `Application ribbon component lookup unavailable: ${String(error)}`);
						return [] as string[];
					}),
				]);
				if (cancelled) return;
				setSolutionEntityIds(entityIds);
				setSolutionRibbonComponentIds(ribbonIds);

				if (entityIds.length === 0) {
					setEntities([]);
					return;
				}

				const ents = await fetchEntitiesByMetadataIds(entityIds);
				if (cancelled) return;
				setEntities(ents);
			} catch (error) {
				if (cancelled) return;
				logError(
					"runtime",
					`Failed to load solution tables: ${error instanceof Error ? error.message : String(error)
					}`,
				);
				setSolutionEntityIds([]);
				setSolutionRibbonComponentIds([]);
				setEntities([]);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [activeSolution, setEntities, setSolutionEntityIds, setSolutionRibbonComponentIds, logError, logWarn]);

	// ----- When the user picks an entity (inside an active solution),
	// load the ribbon workspace.
	useEffect(() => {
		clearWorkspace();
		setShowRestoreBanner(false);
		setPendingRestore(null);
		setRestoreError(null);
		if (!activeEntity?.logicalName || !activeSolution || !connectionUrl) {
			setRibbonLoadState("idle");
			setRibbonLoadError(null);
			return;
		}

		let cancelled = false;
		setRibbonLoadState("loading");
		setRibbonLoadError(null);
		logInfo("ribbon", `Loading ribbon workspace for ${activeEntity.logicalName}...`);

		// Load the ribbon and its solution-layer provenance in parallel, then
		// overlay accurate OOB/managed/unmanaged origin onto each button before
		// seeding the store. Provenance is best-effort — if the layer API is
		// unavailable we keep the parser's heuristic (so this never blocks load).
		void Promise.all([
			fetchSourceBoundWorkspace(activeSolution.uniqueName, activeEntity.logicalName, connectionUrl),
			fetchRibbonProvenance(activeEntity.logicalName).catch(
				() => new Map<string, ButtonProvenance>(),
			),
		])
			.then(([loaded, provenance]) => {
				if (cancelled) return;
				const { workspace, sourceSnapshot: source, sourceError } = loaded;
				if (sourceError) logWarn("publish", `Publication unavailable until source can be loaded: ${sourceError}. The editor remains available.`);
				applyProvenanceToRibbons(workspace.ribbons, provenance);

				// Build ConflictEntry records for buttons whose provenance resolved
				// to "managed" — i.e. they belong to a managed solution layer.
				// The ConflictBanner uses these to surface a warning without any
				// additional API calls. The ConflictDrawer then fetches live layer
				// detail on demand.
				const conflictEntries: ConflictEntry[] = [];
				const seenButtonIds = new Set<string>();
				for (const ribbon of Object.values(workspace.ribbons)) {
					for (const tab of ribbon.tabs) {
						for (const group of tab.groups) {
							for (const btn of group.buttons) {
								if (btn.origin === "managed" && !seenButtonIds.has(btn.id)) {
									seenButtonIds.add(btn.id);
									conflictEntries.push({
										elementId: btn.id,
										elementKind: "button",
										solutions: [
											{
												solutionId: "",
												solutionName: btn.solutionName ?? "Managed Solution",
												publisher: btn.publisherName ?? "",
												managed: true,
												wins: true,
												importedOn: undefined,
											},
										],
									});
								}
							}
						}
					}
				}
				// Sync to store without triggering a history entry.
				useRibbonStore.getState().setConflicts(conflictEntries);

				loadWorkspace({
					ribbons: workspace.ribbons,
					commands: workspace.commands,
					displayRules: workspace.displayRules,
					enableRules: workspace.enableRules,
					locLabels: workspace.locLabels,
					sourceSnapshot: source,
					conflicts: conflictEntries,
				});

				// Snapshot the current selection at success-time via getState()
				// — depending on the reactive `location` / `tabId` selectors
				// here would re-fire this whole effect (and the RetrieveEntityRibbon
				// + RetrieveApplicationRibbon network calls) every time the user
				// clicks a tab or switches between Home/Sub/Form/Application.
				const { location: currentLocation, tabId: currentTabId } = useSelectionStore.getState();
				const tabsForLocation = workspace.ribbons[currentLocation]?.tabs ?? [];
				const tabStillExists = tabsForLocation.some((t) => t.id === currentTabId);
				if (!tabStillExists) {
					const firstTabId = tabsForLocation[0]?.id;
					if (firstTabId) setTabId(firstTabId);
				}

				setRibbonLoadState("idle");
				logInfo("ribbon", `Ribbon workspace loaded for ${activeEntity.logicalName}.`);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : "Failed to load ribbon";
				setRibbonLoadState("error");
				setRibbonLoadError(message);
				logError("ribbon", `Ribbon load failed for ${activeEntity.logicalName}: ${message}`);
			});

		return () => {
			cancelled = true;
		};
	}, [activeEntity?.logicalName, activeSolution, connectionUrl, loadWorkspace, clearWorkspace, reloadVersion, setTabId, logInfo, logWarn, logError]);

	// Check for persisted state when entity or connection changes
	useEffect(() => {
		if (!sourceSnapshot?.organizationUrl || mutationsSincePublish > 0) {
			setShowRestoreBanner(false);
			return;
		}
		const saved = loadPersistedRibbonData(sourceSnapshot.organizationUrl, sourceSnapshot.entityLogicalName, sourceSnapshot.solutionUniqueName, sourceSnapshot.userId);
		if (saved) {
			setPendingRestore(saved);
			setShowRestoreBanner(true);
		} else {
			setShowRestoreBanner(false);
			setPendingRestore(null);
		}
	}, [sourceSnapshot, mutationsSincePublish]);

	function handleRestore() {
		if (!pendingRestore) return;
		try {
			restoreDraft(pendingRestore);
			setShowRestoreBanner(false);
			setPendingRestore(null);
			setRestoreError(null);
		} catch (error) {
			setRestoreError(error instanceof Error ? error.message : String(error));
		}
	}

	function handleDiscard() {
		if (sourceSnapshot?.organizationUrl) {
			clearPersistedRibbonData(sourceSnapshot.organizationUrl, sourceSnapshot.entityLogicalName, sourceSnapshot.solutionUniqueName, sourceSnapshot.userId);
		}
		setShowRestoreBanner(false);
		setPendingRestore(null);
		setRestoreError(null);
	}

	function handleRetryRibbonLoad() {
		setReloadVersion((v) => v + 1);
	}

	function downloadSavedDraft() {
		if (!pendingRestore) return;
		const url = URL.createObjectURL(new Blob([JSON.stringify(pendingRestore, null, 2)], { type: "application/json" }));
		const link = document.createElement("a"); link.href = url; link.download = `${pendingRestore.sourceSnapshot.entityLogicalName}-ribbon-draft.json`;
		link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	return (
		<FluentProvider theme={themeMode === "dark" ? webDarkTheme : webLightTheme}>
			<Layout leftPane={<LeftPane />} rightPane={<PropertiesPane />} bottomPanel={<BottomPanel />}>
				{showRestoreBanner && pendingRestore && (
					<MessageBar
						intent="warning"
						style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000 }}
					>
						<MessageBarBody>
							{restoreError || <>You have unsaved changes from a previous session (saved{" "}
								{new Date(pendingRestore.savedAt).toLocaleString()}).
							</>}
						</MessageBarBody>
						<MessageBarActions
							containerAction={
								<Button size="small" appearance="subtle" onClick={handleDiscard}>
									Discard
								</Button>
							}
						>
							<Button size="small" appearance="primary" onClick={handleRestore}>
								Restore
							</Button>
							<Button size="small" onClick={downloadSavedDraft}>Download draft</Button>
						</MessageBarActions>
					</MessageBar>
				)}
				<RibbonCanvas
					isLoadingRibbon={ribbonLoadState === "loading"}
					ribbonLoadError={ribbonLoadError}
					onRetryRibbonLoad={handleRetryRibbonLoad}
				/>
			</Layout>
		</FluentProvider>
	);
}
