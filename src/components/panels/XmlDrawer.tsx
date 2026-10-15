import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
	makeStyles,
	tokens,
	DrawerBody,
	DrawerHeader,
	DrawerHeaderTitle,
	OverlayDrawer,
	Button,
	Tab,
	TabList,
	ToolbarButton,
	MessageBar,
	MessageBarBody,
} from "@fluentui/react-components";
import {
	DismissRegular,
	CopyRegular,
	ArrowDownloadRegular,
	CodeBlockRegular,
	TextEditStyleRegular,
	ArrowUploadRegular,
} from "@fluentui/react-icons";
import { useUIStore } from "@/store/uiStore";
import { useRibbonStore } from "@/store/ribbonStore";
import { generateRibbonDiffXml } from "@/services/xmlGenerator";
import { buildRibbonPreview } from "@/services/ribbonPreview";
import { loadWebResources } from "@/services/dataverse/webResourceService";
import type { RibbonLocation } from "@/types/ribbon";
import MonacoEditor from "@/components/shared/MonacoEditor";
import { registerMonacoCompletions, disposeMonacoCompletions } from "@/utils/monacoCompletions";

const useStyles = makeStyles({
	drawer: {
		width: "960px",
		maxWidth: "90vw",
	},
	body: {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		overflow: "hidden",
		// Strip the DrawerBody's default padding so the editor can flush to
		// the edges and the layout stays tight.
		padding: 0,
	},
	infoBar: {
		flexShrink: 0,
		margin: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
	},
	tabRow: {
		flexShrink: 0,
		padding: `0 ${tokens.spacingHorizontalM}`,
	},
	toolbar: {
		flexShrink: 0,
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
		padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
		borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
		borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
	},
	editorContainer: {
		flex: 1,
		minHeight: 0, // critical — without this, flex children can overflow their parent
		overflow: "hidden",
	},
});

const LOCATIONS: { label: string; value: RibbonLocation }[] = [
	{ label: "Home Grid", value: "HomepageGrid" },
	{ label: "Sub Grid", value: "SubGrid" },
	{ label: "Form", value: "Form" },
	{ label: "Application", value: "Application" },
];

export const XmlDrawer: React.FC = () => {
	const styles = useStyles();
	const xmlDrawerOpen = useUIStore((s) => s.xmlDrawerOpen);
	const closeXmlDrawer = useUIStore((s) => s.closeXmlDrawer);
	const ribbons = useRibbonStore((s) => s.ribbons);
	const baseline = useRibbonStore((s) => s.baseline);
	const baselineDefinitions = useRibbonStore((s) => s.baselineDefinitions);
	const sourceSnapshot = useRibbonStore((s) => s.sourceSnapshot);
	const commands = useRibbonStore((s) => s.commands);
	const displayRules = useRibbonStore((s) => s.displayRules);
	const enableRules = useRibbonStore((s) => s.enableRules);
	const locLabels = useRibbonStore((s) => s.locLabels);

	const openImportXml = useUIStore((s) => s.openImportXml);

	const [activeLocation, setActiveLocation] = useState<RibbonLocation>("HomepageGrid");
	const [webResourceNames, setWebResourceNames] = useState<string[]>([]);
	const [actionError, setActionError] = useState<string | null>(null);

	// Editor instance ref for Format action
	const editorInstanceRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(
		null,
	);
	const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

	// Monaco completion providers — registered once when editor mounts, cleaned up on unmount
	const completionDisposablesRef = useRef<import("monaco-editor").IDisposable[]>([]);
	useEffect(() => {
		if (!xmlDrawerOpen) return;
		let cancelled = false;
		// Web-resource completion lookup is advisory. A transport failure or a
		// stale response after drawer close must not crash/obscure the XML editor.
		void Promise.resolve()
			.then(() => loadWebResources())
			.then((rows) => {
				if (cancelled) return;
				const names = rows.map((row) => row.name);
				setWebResourceNames((previous) =>
					previous.length === names.length && previous.every((name, index) => name === names[index]) ? previous : names,
				);
			})
			.catch(() => { if (!cancelled) setWebResourceNames((previous) => previous.length ? [] : previous); });
		return () => { cancelled = true; };
	}, [xmlDrawerOpen]);

	useEffect(() => {
		return () => {
			disposeMonacoCompletions(completionDisposablesRef.current);
			completionDisposablesRef.current = [];
		};
	}, []);

	const handleEditorMount = useCallback(
		(
			editor: import("monaco-editor").editor.IStandaloneCodeEditor,
			monacoApi: typeof import("monaco-editor"),
		) => {
			editorInstanceRef.current = editor;
			monacoRef.current = monacoApi;
			// Only register once — dispose previous registrations first
			disposeMonacoCompletions(completionDisposablesRef.current);
			completionDisposablesRef.current = registerMonacoCompletions(
				monacoApi,
				() => webResourceNames,
			);
		},
		[webResourceNames],
	);

	useEffect(() => {
		if (!monacoRef.current) return;
		disposeMonacoCompletions(completionDisposablesRef.current);
		completionDisposablesRef.current = registerMonacoCompletions(
			monacoRef.current,
			() => webResourceNames,
		);
	}, [webResourceNames]);

	const handleFormatXml = () => {
		void editorInstanceRef.current?.getAction("editor.action.formatDocument")?.run();
	};

	const preview = useMemo(() => {
		let sourceError: string | null = null;
		try {
			const complete = buildRibbonPreview({
				current: { ribbons, commands, displayRules, enableRules, locLabels },
				baseline: { ribbons: baseline, ...baselineDefinitions },
				sourceSnapshot,
			}, activeLocation === "Application" ? "application" : "entity");
			return { xml: `<?xml version="1.0" encoding="utf-8"?>\n${complete.mergedXml}`, complete: true, sourceError: null };
		} catch (cause) {
			sourceError = cause instanceof Error ? cause.message : String(cause);
		}
		try {
			// Inspection-only fallback. It MUST NOT be represented as the complete
			// unmanaged layer: only the merged source can be safely packaged.
			const fragment = generateRibbonDiffXml({
				location: activeLocation,
				current: ribbons[activeLocation],
				baseline: baseline[activeLocation],
				commands,
				displayRules,
				enableRules,
				locLabels,
				baselineDefinitions,
				entityLogicalName: ribbons[activeLocation].entityLogicalName,
			});
			return { xml: `<?xml version="1.0" encoding="utf-8"?>\n${fragment}`, complete: false, sourceError };
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			return {
				xml: "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<RibbonDiffXml/>",
				complete: false,
				sourceError: `${sourceError} Delta generation also failed: ${reason}`,
			};
		}
	}, [activeLocation, ribbons, baseline, baselineDefinitions, sourceSnapshot, commands, displayRules, enableRules, locLabels]);

	const xml = preview.xml;

	const handleCopy = async () => {
		setActionError(null);
		try {
			if (window.toolboxAPI?.utils?.copyToClipboard) {
				await window.toolboxAPI.utils.copyToClipboard(xml);
				return;
			}
		} catch {
			// Host clipboard can fail in a native web resource: retry browser API.
		}
		try {
			if (!navigator.clipboard?.writeText) throw new Error("No clipboard API is available.");
			await navigator.clipboard.writeText(xml);
		} catch (cause) {
			setActionError(`Could not copy XML to the clipboard: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	};

	const handleDownload = () => {
		setActionError(null);
		let url: string | undefined;
		try {
			url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = `RibbonDiffXml_${activeLocation}_${preview.complete ? "complete" : "delta-only"}.xml`;
			a.click();
		} catch (cause) {
			setActionError(`Could not download the XML preview: ${cause instanceof Error ? cause.message : String(cause)}`);
		} finally {
			if (url) URL.revokeObjectURL(url);
		}
	};

	return (
		<OverlayDrawer
			position="end"
			open={xmlDrawerOpen}
				onOpenChange={(_, data) => { if (!data.open) closeXmlDrawer(); }}
			className={styles.drawer}
		>
			<DrawerHeader>
				<DrawerHeaderTitle
					action={
						<Button
							appearance="subtle"
							icon={<DismissRegular />}
							onClick={closeXmlDrawer}
							aria-label="Close XML drawer"
						/>
					}
				>
					<CodeBlockRegular style={{ marginRight: tokens.spacingHorizontalS }} />
					RibbonDiffXml
				</DrawerHeaderTitle>
			</DrawerHeader>
			<DrawerBody className={styles.body}>
					<MessageBar className={styles.infoBar} intent={preview.complete ? "info" : "warning"}>
						<MessageBarBody>
							{preview.complete ? (
								<>
									Complete unmanaged <strong>RibbonDiffXml</strong> preview from the exported solution source.
									{activeLocation === "Application"
										? " This Application tab shows the complete preserved application layer."
										: " Home Grid, Sub Grid and Form tabs each show the same complete preserved entity layer containing changes from all three locations."}
									 This is inspection only; Copy and Download never publish to the server.
								</>
							) : (
								<>
									The complete exported unmanaged source is unavailable: {preview.sourceError}
									 This editor shows an inspection-only delta fallback for the selected location.
									 It cannot publish without a valid matching exported solution source.
								</>
							)}
						</MessageBarBody>
					</MessageBar>

				<div className={styles.tabRow}>
					<TabList
						selectedValue={activeLocation}
							onTabSelect={(_, d) => { setActiveLocation(d.value as RibbonLocation); setActionError(null); }}
					>
						{LOCATIONS.map((loc) => (
							<Tab key={loc.value} value={loc.value}>
								{loc.label}
							</Tab>
						))}
					</TabList>
				</div>

				<div className={styles.toolbar}>
						<ToolbarButton icon={<CopyRegular />} onClick={() => { void handleCopy(); }}>
						Copy
					</ToolbarButton>
					<ToolbarButton icon={<ArrowDownloadRegular />} onClick={handleDownload}>
						Download
					</ToolbarButton>
					<ToolbarButton icon={<TextEditStyleRegular />} onClick={handleFormatXml}>
						Format XML
					</ToolbarButton>
					<ToolbarButton icon={<ArrowUploadRegular />} onClick={openImportXml}>
						Import this XML
					</ToolbarButton>
					</div>
					{actionError && <MessageBar className={styles.infoBar} intent="error"><MessageBarBody>{actionError}</MessageBarBody></MessageBar>}

					<div className={styles.editorContainer}>
					<MonacoEditor
						language="xml"
						value={xml}
						readOnly
						height="100%"
						onMount={handleEditorMount}
					/>
				</div>
			</DrawerBody>
		</OverlayDrawer>
	);
};

export default XmlDrawer;
