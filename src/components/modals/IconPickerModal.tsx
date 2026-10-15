import React, { useState, useMemo } from "react";
import {
	makeStyles,
	tokens,
	Dialog,
	DialogSurface,
	DialogBody,
	DialogTitle,
	DialogContent,
	DialogActions,
	Button,
	Input,
	Tab,
	TabList,
	Text,
	Badge,
	Subtitle2,
	Switch,
	Combobox,
	Option,
} from "@fluentui/react-components";
import { DismissRegular, SearchRegular, CloudArrowUpRegular } from "@fluentui/react-icons";
import { useUIStore } from "@/store/uiStore";
import { useRibbonStore } from "@/store/ribbonStore";
import { useSelectionStore } from "@/store/selectionStore";
import { useSessionStore } from "@/store/sessionStore";
import { useRuntimeLogStore } from "@/store/runtimeLogStore";
import FluentIcon from "@/components/shared/FluentIcon";
import { fluentIconToSvg } from "@/utils/fluentIconSvg";
import {
	loadWebResources,
	saveWebResource,
	publishWebResource,
} from "@/services/dataverse/webResourceService";
import type { WebResource } from "@/types/webResource";

/** Convert PascalCase icon name to snake_case Fluent icon name, e.g. "CreditCard" → "credit_card" */
function toSnakeCase(name: string): string {
	return name.replace(/([A-Z])/g, (c, _m, i) => (i > 0 ? "_" : "") + c.toLowerCase());
}

/** UTF-8-safe base64 encode (web-resource `content` must be base64). */
function toBase64Utf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

const CATEGORY_HINTS: Array<{ category: string; keywords: string[] }> = [
	{
		category: "Actions",
		keywords: [
			"Add",
			"Delete",
			"Edit",
			"Save",
			"Copy",
			"Paste",
			"Undo",
			"Redo",
			"Send",
			"Print",
			"Refresh",
		],
	},
	{ category: "Communication", keywords: ["Mail", "Chat", "Phone", "Call", "Message"] },
	{
		category: "Navigation",
		keywords: ["Arrow", "Chevron", "Navigation", "Home", "Back", "Forward"],
	},
	{
		category: "System",
		keywords: ["Settings", "Info", "Warning", "Dismiss", "Question", "Checkmark", "Error"],
	},
	{ category: "Security", keywords: ["Lock", "Shield", "Key", "Fingerprint"] },
	{ category: "People", keywords: ["Person", "People", "Contact", "User"] },
	{
		category: "Business",
		keywords: ["Building", "Briefcase", "Money", "Credit", "Cart", "Tag", "Receipt"],
	},
	{ category: "Files", keywords: ["Document", "Folder", "Attach", "Upload", "Download", "File"] },
	{ category: "Web", keywords: ["Globe", "Link", "Open", "Browser", "World"] },
	{ category: "Time", keywords: ["Calendar", "Clock", "Timer", "History"] },
	{ category: "Rating", keywords: ["Star", "Heart", "Thumb"] },
	{ category: "View", keywords: ["Eye", "Zoom", "View", "Window", "Preview"] },
	{ category: "Layout", keywords: ["Grid", "List", "Table", "Panel", "Column", "Row"] },
	{ category: "Development", keywords: ["Code", "Bug", "Branch", "Wrench", "Tool", "Terminal"] },
	{ category: "Media", keywords: ["Play", "Pause", "Stop", "Video", "Audio", "Camera"] },
	{ category: "Analytics", keywords: ["Chart", "Data", "Poll", "Graph", "Trend"] },
];

const FLUENT_ICON_NAMES = [
	"Add",
	"Delete",
	"Edit",
	"Save",
	"Copy",
	"Cut",
	"ClipboardPaste",
	"Share",
	"Mail",
	"Chat",
	"Phone",
	"Search",
	"Filter",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"ChevronDown",
	"ChevronUp",
	"Navigation",
	"Home",
	"Settings",
	"Info",
	"Warning",
	"Checkmark",
	"Dismiss",
	"QuestionCircle",
	"LockClosed",
	"LockOpen",
	"Shield",
	"Person",
	"People",
	"PersonAdd",
	"Building",
	"Briefcase",
	"Money",
	"CreditCard",
	"Cart",
	"Tag",
	"Document",
	"DocumentBulletList",
	"Folder",
	"FolderOpen",
	"Attach",
	"ArrowDownload",
	"ArrowUpload",
	"Globe",
	"Link",
	"Open",
	"Calendar",
	"Clock",
	"Timer",
	"Star",
	"Heart",
	"ThumbLike",
	"ThumbDislike",
	"Eye",
	"EyeOff",
	"ZoomIn",
	"ZoomOut",
	"Maximize",
	"Minimize",
	"Grid",
	"List",
	"Table",
	"TableSimple",
	"Code",
	"Bug",
	"Play",
	"Pause",
	"Stop",
	"Refresh",
	"ArrowSync",
	"ArrowUndo",
	"ArrowRedo",
	"Printer",
	"Send",
	"Rocket",
	"Sparkle",
	"Trophy",
	"Lightbulb",
	"Bot",
	"DataBar",
	"ChartMultiple",
	"Poll",
] as const;

function classifyIconCategory(name: string): string {
	for (const hint of CATEGORY_HINTS) {
		if (hint.keywords.some((keyword) => name.includes(keyword))) {
			return hint.category;
		}
	}
	return "General";
}

const FLUENT_ICON_CATALOGUE: { name: string; category: string }[] = FLUENT_ICON_NAMES.map(
	(name) => ({
		name,
		category: classifyIconCategory(name),
	}),
);

const ALL_CATEGORIES = [
	"All",
	...Array.from(new Set(FLUENT_ICON_CATALOGUE.map((i) => i.category))).sort(),
];

const useStyles = makeStyles({
	surface: {
		width: "720px",
		maxWidth: "95vw",
		height: "min(580px, 90vh)",
		maxHeight: "90vh",
		overflow: "hidden",
	},
	dialogBody: {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		minHeight: 0,
	},
	body: {
		display: "flex",
		flexDirection: "column",
		flex: 1,
		minHeight: 0,
		overflow: "hidden",
		gap: tokens.spacingHorizontalS,
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
		flexWrap: "wrap",
		flexShrink: 0,
	},
	categoryPicker: {
		minWidth: "180px",
		maxWidth: "220px",
	},
	iconGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
		gap: tokens.spacingHorizontalXS,
		overflowY: "auto",
		flex: 1,
		minHeight: 0,
		padding: tokens.spacingHorizontalXS,
	},
	iconTile: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: "4px",
		padding: tokens.spacingHorizontalXS,
		borderRadius: tokens.borderRadiusMedium,
		border: "1px solid transparent",
		cursor: "pointer",
		minHeight: "64px",
		":hover": {
			backgroundColor: tokens.colorNeutralBackground3,
			border: `1px solid ${tokens.colorNeutralStroke1}`,
		},
	},
	iconTileSelected: {
		backgroundColor: tokens.colorBrandBackground2,
		border: `1px solid ${tokens.colorBrandStroke1}`,
	},
	iconLabel: {
		fontSize: tokens.fontSizeBase100,
		textAlign: "center",
		lineHeight: 1.2,
		wordBreak: "break-word",
		color: tokens.colorNeutralForeground2,
	},
	webResourceList: {
		flex: 1,
		overflowY: "auto",
	},
	webResourceRow: {
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
		padding: `${tokens.spacingHorizontalXS} ${tokens.spacingHorizontalS}`,
		cursor: "pointer",
		borderRadius: tokens.borderRadiusMedium,
		":hover": { backgroundColor: tokens.colorNeutralBackground3 },
	},
	uploadArea: {
		flex: 1,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: tokens.spacingHorizontalM,
		border: `2px dashed ${tokens.colorNeutralStroke2}`,
		borderRadius: tokens.borderRadiusMedium,
		color: tokens.colorNeutralForeground3,
	},
});

type IconPickerTab = "fluent" | "webresource" | "upload";

interface IconPickerModalProps {
	onSelect?: (icon: string, image16: string, image32: string) => void;
}

export const IconPickerModal: React.FC<IconPickerModalProps> = () => {
	const styles = useStyles();
	const open = useUIStore((s) => s.iconPickerOpen);
	const closeIconPicker = useUIStore((s) => s.closeIconPicker);
	const setButtonProp = useRibbonStore((s) => s.setButtonProp);
	const selectedButtonId = useSelectionStore((s) => s.selectedButtonId);
	const selectedGroupId = useSelectionStore((s) => s.selectedGroupId);
	const tabId = useSelectionStore((s) => s.tabId);
	const location = useSelectionStore((s) => s.location);
	const publisherPrefix = useSessionStore((s) => s.publisherPrefix);

	const [activeTab, setActiveTab] = useState<IconPickerTab>("fluent");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("All");
	const [variant, setVariant] = useState<"regular" | "filled">("regular");
	const [selectedIcon, setSelectedIcon] = useState<string | null>(null);
	const [webResourcePath, setWebResourcePath] = useState("");
	const [webResources, setWebResources] = useState<WebResource[]>([]);
	const [loadingWebResources, setLoadingWebResources] = useState(false);
	const [iconSearch, setIconSearch] = useState("");
	const [uploading, setUploading] = useState(false);

	React.useEffect(() => {
		if (!open || activeTab !== "webresource") return;
		setLoadingWebResources(true);
		void loadWebResources("svg")
			.then((rows) => setWebResources(rows))
			.catch(() => setWebResources([]))
			.finally(() => setLoadingWebResources(false));
	}, [open, activeTab]);

	const visibleWebResources = useMemo(() => {
		const q = iconSearch.toLowerCase();
		return webResources.filter((wr) => !q || wr.name.toLowerCase().includes(q));
	}, [iconSearch, webResources]);

	const filteredIcons = useMemo(() => {
		const q = search.toLowerCase();
		return FLUENT_ICON_CATALOGUE.filter(
			(icon) =>
				(category === "All" || icon.category === category) &&
				(q === "" || icon.name.toLowerCase().includes(q)),
		);
	}, [search, category]);

	const handleSelectFluentIcon = async () => {
		if (!selectedIcon || !selectedButtonId || !selectedGroupId) return;
		const prefix = publisherPrefix || "new";
		const iconName = toSnakeCase(selectedIcon);
		const logs = useRuntimeLogStore.getState();

		// A Fluent icon is a CBS-UI-only React component — it is NOT a Dataverse
		// web resource. Previously we fabricated `$webresource:…_16.svg` paths
		// that pointed at files which never existed; the ribbon compile then
		// failed to resolve them and the button silently never rendered.
		//
		// Instead, serialize the icon to SVG and upload it as a REAL web resource,
		// then reference that. `icon` keeps the Fluent name purely for the CBS
		// canvas preview (the generator never emits it as a bare ModernImage).
		setUploading(true);
		try {
			const svg = await fluentIconToSvg(selectedIcon, 32);
			if (!svg) throw new Error(`Could not serialize Fluent icon "${selectedIcon}"`);
			const wrName = `${prefix}_/icons/${iconName}.svg`;
			const content = toBase64Utf8(svg);
			const { id } = await saveWebResource(wrName, content, 11, `${iconName}.svg`);
			// Best-effort publish so the new web resource is immediately live; the
			// button still resolves the dependency (record exists) even if this is
			// skipped, so failures here are non-fatal.
			try {
				await publishWebResource(id);
			} catch (pubErr) {
				logs.logWarn(
					"webresource",
					`Created icon web resource ${wrName} but publish failed: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}. It will publish with the next Publish.`,
				);
			}
			setButtonProp(location, tabId, selectedGroupId, selectedButtonId, {
				icon: iconName,
				image16: `$webresource:${wrName}`,
				image32: `$webresource:${wrName}`,
			});
			logs.logInfo("webresource", `Icon web resource ready: ${wrName}`);
		} catch (err) {
			// Fallback: preview-only. Set the Fluent name for the canvas but emit
			// NO web-resource references, so the button still renders (just without
			// a Dataverse icon) instead of being dropped by a broken reference.
			logs.logWarn(
				"webresource",
				`Fluent icon "${selectedIcon}" could not be uploaded as a web resource (${err instanceof Error ? err.message : String(err)}). Using preview-only; add a real icon via the Web resource tab.`,
			);
			setButtonProp(location, tabId, selectedGroupId, selectedButtonId, {
				icon: iconName,
				image16: undefined,
				image32: undefined,
			});
		} finally {
			setUploading(false);
			closeIconPicker();
		}
	};

	const handleSelectWebResource = () => {
		if (!webResourcePath || !selectedButtonId || !selectedGroupId) return;
		setButtonProp(location, tabId, selectedGroupId, selectedButtonId, {
			image16: webResourcePath,
			image32: webResourcePath,
		});
		closeIconPicker();
	};

	const handleUploadSvg = async (file: File) => {
		setUploading(true);
		try {
			const content = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onerror = () => reject(reader.error ?? new Error("Failed to read SVG"));
				reader.onload = () => {
					const val = String(reader.result ?? "");
					resolve(val.includes(",") ? (val.split(",")[1] ?? "") : val);
				};
				reader.readAsDataURL(file);
			});
			const name = `${publisherPrefix ?? "new"}_/icons/${file.name}`;
			await saveWebResource(name, content, 11, file.name);
			setWebResourcePath(`$webresource:${name}`);
			setActiveTab("webresource");
			const rows = await loadWebResources("svg");
			setWebResources(rows);
		} finally {
			setUploading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(_, d) => !d.open && closeIconPicker()}>
			<DialogSurface className={styles.surface}>
				<DialogBody className={styles.dialogBody}>
					<DialogTitle
						action={
							<Button
								appearance="subtle"
								icon={<DismissRegular />}
								onClick={closeIconPicker}
								aria-label="Close"
							/>
						}
					>
						<Subtitle2>Choose Icon</Subtitle2>
					</DialogTitle>

					<DialogContent className={styles.body}>
						<TabList
							selectedValue={activeTab}
							onTabSelect={(_, d) => setActiveTab(d.value as IconPickerTab)}
							size="small"
						>
							<Tab value="fluent">Fluent icons</Tab>
							<Tab value="webresource">Web resources</Tab>
							<Tab value="upload">Upload SVG</Tab>
						</TabList>

						{activeTab === "fluent" && (
							<>
								<div className={styles.toolbar}>
									<Input
										contentBefore={<SearchRegular />}
										placeholder="Search icons…"
										value={search}
										onChange={(_, d) => setSearch(d.value)}
										size="small"
										style={{ flex: 1 }}
									/>
									<Combobox
										className={styles.categoryPicker}
										placeholder="Category"
										value={category}
										onOptionSelect={(_, data) => setCategory(String(data.optionValue ?? "All"))}
									>
										{ALL_CATEGORIES.map((cat) => (
											<Option key={cat} value={cat} text={cat}>
												{cat}
											</Option>
										))}
									</Combobox>
									<Switch
										label={variant === "regular" ? "Regular" : "Filled"}
										checked={variant === "filled"}
										onChange={(_, d) => setVariant(d.checked ? "filled" : "regular")}
									/>
								</div>
								<div className={styles.iconGrid}>
									{filteredIcons.map((icon) => {
										return (
											<div
												key={icon.name}
												className={`${styles.iconTile} ${selectedIcon === icon.name ? styles.iconTileSelected : ""}`}
												onClick={() => setSelectedIcon(icon.name)}
												role="option"
												aria-selected={selectedIcon === icon.name}
												title={`${icon.name} — ${icon.category}`}
											>
												<FluentIcon name={toSnakeCase(icon.name)} size={24} variant={variant} />
												<span className={styles.iconLabel}>{icon.name}</span>
											</div>
										);
									})}
								</div>
								{selectedIcon && (
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: tokens.spacingHorizontalS,
											padding: tokens.spacingHorizontalXS,
											backgroundColor: tokens.colorNeutralBackground3,
											borderRadius: tokens.borderRadiusMedium,
											flexShrink: 0,
										}}
									>
										<Text size={200} style={{ fontFamily: tokens.fontFamilyMonospace }}>
											ModernImage=&quot;{selectedIcon}&quot;
										</Text>
										<Badge appearance="tint" color="success">
											Selected
										</Badge>
									</div>
								)}
							</>
						)}

						{activeTab === "webresource" && (
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									gap: tokens.spacingHorizontalS,
									flex: 1,
								}}
							>
								<Input
									contentBefore={<SearchRegular />}
									placeholder="Search SVG web resources..."
									value={iconSearch}
									onChange={(_, d) => setIconSearch(d.value)}
									size="small"
								/>
								<div className={styles.webResourceList}>
									{loadingWebResources && (
										<Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
											Loading web resources...
										</Text>
									)}
									{!loadingWebResources &&
										visibleWebResources.slice(0, 200).map((wr) => {
											const path = `$webresource:${wr.name}`;
											const selected = webResourcePath === path;
											return (
												<div
													key={wr.id}
													className={styles.webResourceRow}
													onClick={() => setWebResourcePath(path)}
													style={{
														backgroundColor: selected ? tokens.colorBrandBackground2 : undefined,
													}}
												>
													<Text size={200} style={{ fontFamily: tokens.fontFamilyMonospace }}>
														{path}
													</Text>
												</div>
											);
										})}
								</div>
								<Input
									placeholder="$webresource:publisher_/icons/…"
									value={webResourcePath}
									onChange={(_, d) => setWebResourcePath(d.value)}
								/>
								<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
									Both image16 and image32 will be set to this path. Use SVG for best results across
									all DPI levels.
								</Text>
							</div>
						)}

						{activeTab === "upload" && (
							<div className={styles.uploadArea}>
								<CloudArrowUpRegular fontSize={48} style={{ opacity: 0.4 }} />
								<Text>Drag an SVG file here, or click to browse</Text>
								<Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
									The file will be uploaded as a web resource in the active solution.
								</Text>
								<input
									type="file"
									accept=".svg"
									style={{ display: "none" }}
									id="icon-upload-input"
									onChange={(e) => {
										const file = e.target.files?.[0];
										if (!file) return;
										void handleUploadSvg(file);
									}}
								/>
								<label
									htmlFor="icon-upload-input"
									style={{
										display: "inline-block",
										cursor: "pointer",
										padding: "6px 12px",
										background: tokens.colorBrandBackground,
										color: tokens.colorNeutralForegroundOnBrand,
										borderRadius: tokens.borderRadiusMedium,
										fontSize: tokens.fontSizeBase300,
									}}
								>
									{uploading ? "Uploading..." : "Browse for SVG"}
								</label>
							</div>
						)}
					</DialogContent>

					<DialogActions>
						<Button appearance="secondary" onClick={closeIconPicker}>
							Cancel
						</Button>
						{activeTab === "fluent" && (
							<Button
								appearance="primary"
								disabled={!selectedIcon || uploading}
								onClick={() => void handleSelectFluentIcon()}
							>
								{uploading ? "Adding icon…" : `Use ${selectedIcon ?? "icon"}`}
							</Button>
						)}
						{activeTab === "webresource" && (
							<Button
								appearance="primary"
								disabled={!webResourcePath}
								onClick={handleSelectWebResource}
							>
								Use web resource
							</Button>
						)}
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
};

export default IconPickerModal;
