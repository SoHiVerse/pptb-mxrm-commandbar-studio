import React, { useMemo, Suspense } from "react";
import {
	makeStyles,
	tokens,
	DrawerBody,
	DrawerHeader,
	DrawerHeaderTitle,
	OverlayDrawer,
	Button,
	Text,
	Badge,
	Subtitle2,
	MessageBar,
	MessageBarBody,
	Spinner,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { useUIStore } from "@/store/uiStore";
import { useRibbonStore } from "@/store/ribbonStore";
import { generateRibbonDiffXml } from "@/services/xmlGenerator";
import type { RibbonLocation } from "@/types/ribbon";
import { buildRibbonPreview, type RibbonPreviewScope } from "@/services/ribbonPreview";
import type { RibbonSourceSnapshot, RibbonWorkspace } from "@/types/workspace";

// Lazy-load DiffEditor so Monaco stays out of the initial bundle
const DiffEditorLazy = React.lazy(() =>
	import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);

type IStandaloneDiffEditor = import("monaco-editor").editor.IStandaloneDiffEditor;

const LOCATIONS: RibbonLocation[] = ["HomepageGrid", "SubGrid", "Form", "Application"];

const useStyles = makeStyles({
	drawer: {},
	body: {
		display: "flex",
		flexDirection: "column",
		flex: "1 1 auto",
		minHeight: 0,
		overflow: "hidden",
		gap: tokens.spacingHorizontalS,
	},
	statsBar: {
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
		padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
		flexShrink: 0,
	},
	toggleRow: {
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
		padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
		borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
		flexShrink: 0,
	},
	editorWrap: {
		flex: 1,
		// height: 0 + flex: 1 = proper flexbox height that children can resolve `height: 100%` against.
		// minHeight ensures at least 400 px even if the panel is very short.
		height: 0,
		minHeight: "400px",
		overflow: "hidden",
		position: "relative",
	},
});

function diffStats(before: string, after: string) {
	const bLines = before.split("\n");
	const aLines = after.split("\n");
	let added = 0;
	let removed = 0;
	const bSet = new Set(bLines);
	const aSet = new Set(aLines);
	for (const line of aLines) if (!bSet.has(line)) added++;
	for (const line of bLines) if (!aSet.has(line)) removed++;
	return { added, removed };
}

function buildDiffDocuments(current: RibbonWorkspace, baseline: RibbonWorkspace, sourceSnapshot: RibbonSourceSnapshot | null) {
	const originals: string[] = [];
	const modified: string[] = [];
	const errors: string[] = [];
	for (const scope of ["entity", "application"] as const satisfies readonly RibbonPreviewScope[]) {
		const title = scope === "entity" ? "Entity (Home Grid + Sub Grid + Form)" : "Application";
		try {
			const preview = buildRibbonPreview({ current, baseline, sourceSnapshot }, scope);
				// Identical headings must not manufacture changes in a no-edit comparison.
				originals.push(`<!-- ${title}: unmanaged ribbon -->\n${preview.originalXml}`);
				modified.push(`<!-- ${title}: unmanaged ribbon -->\n${preview.mergedXml}`);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			errors.push(`${title}: ${reason}`);
			// The upstream comparison editor must still open when source retrieval
			// fails. The fallback is delta ONLY, not an imagined complete baseline.
			originals.push(`<!-- ${title}: complete exported source unavailable. Delta inspection only; cannot publish. -->\n<RibbonDiffXml/>`);
			const scopedLocations: readonly RibbonLocation[] = scope === "entity" ? LOCATIONS.slice(0, 3) : ["Application"];
			const fragments: string[] = [];
			for (const location of scopedLocations) {
				try {
					fragments.push(`<!-- ${location}: unsourced delta -->\n${generateRibbonDiffXml({
						location,
						current: current.ribbons[location], baseline: baseline.ribbons[location],
						commands: current.commands, enableRules: current.enableRules,
						displayRules: current.displayRules, locLabels: current.locLabels,
						baselineDefinitions: baseline,
						entityLogicalName: current.ribbons[location].entityLogicalName,
					})}`);
				} catch {
					fragments.push(`<!-- ${location}: delta generation unavailable; no server write is possible. -->\n<RibbonDiffXml/>`);
				}
			}
			modified.push(`<!-- ${title}: incomplete delta-only fallback; cannot publish without matching source. -->\n${fragments.join("\n\n")}`);
		}
	}
	return { original: originals.join("\n\n"), modified: modified.join("\n\n"), errors };
}

export const DiffViewer: React.FC = () => {
	const styles = useStyles();
	const open = useUIStore((s) => s.diffViewerOpen);
	const mode = useUIStore((s) => s.diffViewerMode);
	const closeDiffViewer = useUIStore((s) => s.closeDiffViewer);
	const themeMode = useUIStore((s) => s.themeMode);
	const [sideBySide, setSideBySide] = React.useState(true);

	const ribbons = useRibbonStore((s) => s.ribbons);
	const baseline = useRibbonStore((s) => s.baseline);
	const baselineDefinitions = useRibbonStore((s) => s.baselineDefinitions);
	const sourceSnapshot = useRibbonStore((s) => s.sourceSnapshot);
	const commands = useRibbonStore((s) => s.commands);
	const displayRules = useRibbonStore((s) => s.displayRules);
	const enableRules = useRibbonStore((s) => s.enableRules);
	const locLabels = useRibbonStore((s) => s.locLabels);

	const isDark = themeMode === "dark";

	const preview = useMemo(
		() => buildDiffDocuments(
			{ ribbons, commands, displayRules, enableRules, locLabels },
			{ ribbons: baseline, ...baselineDefinitions },
			sourceSnapshot,
		),
		[ribbons, baseline, baselineDefinitions, commands, displayRules, enableRules, locLabels, sourceSnapshot],
	);
	const baselineXml = preview.original;
	const currentXml = preview.modified;

	const { added, removed } = diffStats(baselineXml, currentXml);

	// Capture the diff editor instance on mount so we can call updateOptions
	// imperatively. @monaco-editor/react's DiffEditor does not reliably
	// re-apply renderSideBySide via the options prop after the first render.
	const diffEditorRef = React.useRef<IStandaloneDiffEditor | null>(null);

		const handleDiffEditorMount = React.useCallback((editor: IStandaloneDiffEditor) => {
			diffEditorRef.current = editor;
			const models = editor.getModel();
			// The installed React wrapper otherwise disposes models before their
			// diff widget. Let the widget finish first, then release our own models.
			editor.onDidDispose(() => {
				if (diffEditorRef.current === editor) diffEditorRef.current = null;
				queueMicrotask(() => {
					for (const model of [models?.original, models?.modified]) {
						if (model && !model.isDisposed()) model.dispose();
					}
				});
			});
		// Ensure the initial value is applied immediately
		editor.updateOptions({ renderSideBySide: sideBySide });
		// sideBySide intentionally omitted — we only want to sync on mount here
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Imperatively push renderSideBySide whenever the toggle changes
	React.useEffect(() => {
		diffEditorRef.current?.updateOptions({ renderSideBySide: sideBySide });
	}, [sideBySide]);

	return (
		<OverlayDrawer
			className={styles.drawer}
			open={open}
			position="end"
			size="full"
			onOpenChange={(_, d) => !d.open && closeDiffViewer()}
		>
			<DrawerHeader>
				<DrawerHeaderTitle
					action={
						<Button
							appearance="subtle"
							icon={<DismissRegular />}
							onClick={closeDiffViewer}
							aria-label="Close"
						/>
					}
				>
					<Subtitle2>{mode === "compare" ? "Compare to baseline" : "Diff viewer"}</Subtitle2>
				</DrawerHeaderTitle>
			</DrawerHeader>

			<DrawerBody
				style={{
					display: "flex",
					flexDirection: "column",
					flex: "1 1 auto",
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				<div className={styles.body}>
						<MessageBar intent={preview.errors.length ? "warning" : "info"}>
							<MessageBarBody>
								<Text size={200}>
									{preview.errors.length ? (
										`Complete exported source unavailable for: ${preview.errors.join("; ")}. Displaying inspection-only delta fallback where needed; this comparison cannot publish without a matching exported solution source.`
									) : mode === "compare"
										? "Showing complete exported entity and application unmanaged source vs. the preserved merged target, including Home Grid, Sub Grid and Form changes."
										: "Showing the complete exported source against the current merged target for this history view."}
							</Text>
						</MessageBarBody>
					</MessageBar>

					<div className={styles.toggleRow}>
						<Badge appearance="tint" color="success">
							+{added} lines
						</Badge>
						<Badge appearance="tint" color="danger">
							-{removed} lines
						</Badge>
						<div style={{ flex: 1 }} />
						<Button
							appearance={sideBySide ? "primary" : "subtle"}
							size="small"
							onClick={() => setSideBySide(true)}
						>
							Side by side
						</Button>
						<Button
							appearance={!sideBySide ? "primary" : "subtle"}
							size="small"
							onClick={() => setSideBySide(false)}
						>
							Unified
						</Button>
					</div>

					<div className={styles.editorWrap}>
						<Suspense
							fallback={
								<div
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										height: "100%",
									}}
								>
									<Spinner size="medium" label="Loading diff editor…" />
								</div>
							}
						>
							<DiffEditorLazy
								original={baselineXml}
								modified={currentXml}
									language="xml"
									keepCurrentOriginalModel
									keepCurrentModifiedModel
								theme={isDark ? "vs-dark" : "vs"}
								height="100%"
								onMount={handleDiffEditorMount}
								options={{
									readOnly: true,
									renderSideBySide: sideBySide,
									lineNumbers: "on",
									minimap: { enabled: false },
									scrollBeyondLastLine: false,
									automaticLayout: true,
									wordWrap: "on",
								}}
							/>
						</Suspense>
					</div>
				</div>
			</DrawerBody>
		</OverlayDrawer>
	);
};

export default DiffViewer;
