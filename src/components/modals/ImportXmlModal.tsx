import React, { useState } from "react";
import {
	Dialog,
	DialogSurface,
	DialogTitle,
	DialogBody,
	DialogContent,
	DialogActions,
	Button,
	MessageBar,
	MessageBarBody,
	Tab,
	TabList,
	Divider,
} from "@fluentui/react-components";
import { useUIStore } from "@/store/uiStore";
import { getBaselineWorkspace, getEditableWorkspace, useRibbonStore } from "@/store/ribbonStore";
import { useSelectionStore } from "@/store/selectionStore";
import { useSessionStore } from "@/store/sessionStore";
import { validateRibbonDiffXml, type ValidationError } from "@/services/xmlValidator";
import { applyImportedRibbonXml } from "@/services/ribbonXmlImport";
import type { RibbonWorkspace } from "@/types/workspace";
import MonacoEditor from "@/components/shared/MonacoEditor";

type ImportMode = "append" | "replace";

/** Source is needed for publication, not for local editing. Never redirect an import to another selected entity/solution. */
function activeImportError(): string | null {
	const store = useRibbonStore.getState();
	const session = useSessionStore.getState();
	const source = store.sourceSnapshot;
	if (!session.activeEntity || store.ribbons.Form.entityLogicalName !== session.activeEntity.logicalName) {
		return "The selected entity does not match the loaded ribbon workspace. Reload the entity before importing XML.";
	}
	if (!session.activeSolution || session.activeSolution.isManaged) {
		return "Select an unmanaged solution before importing XML into the workspace.";
	}
	if (source && (source.entityLogicalName !== session.activeEntity.logicalName || source.solutionUniqueName !== session.activeSolution.uniqueName)) {
		return "The selected entity or solution does not match the loaded ribbon source. Reload the workspace before importing XML.";
	}
	if (source?.organizationUrl && session.connectionUrl &&
		source.organizationUrl.replace(/\/+$/, "").toLowerCase() !== session.connectionUrl.replace(/\/+$/, "").toLowerCase()) {
		return "The loaded ribbon source belongs to a different organization. Reload the current connection.";
	}
	return null;
}

export const ImportXmlModal: React.FC = () => {
	const importXmlOpen = useUIStore((s) => s.importXmlOpen);
	const closeImportXml = useUIStore((s) => s.closeImportXml);
	const sourceSnapshot = useRibbonStore((s) => s.sourceSnapshot);
	const workspaceGeneration = useRibbonStore((s) => s.workspaceGeneration);
	const mutationsSincePublish = useRibbonStore((s) => s.mutationsSincePublish);
	const activeEntity = useSessionStore((s) => s.activeEntity);
	const activeSolution = useSessionStore((s) => s.activeSolution);
	const connectionUrl = useSessionStore((s) => s.connectionUrl);
	const location = useSelectionStore((s) => s.location);

	const [xmlText, setXmlText] = useState("");
	const [errors, setErrors] = useState<ValidationError[]>([]);
	const [mode, setMode] = useState<ImportMode>("append");
	const [validated, setValidated] = useState<string | null>(null);
	const identity = `${sourceSnapshot?.solutionUniqueName ?? ""}|${sourceSnapshot?.entityLogicalName ?? ""}|${sourceSnapshot?.capturedAt ?? ""}|${activeEntity?.logicalName ?? ""}|${activeSolution?.uniqueName ?? ""}|${connectionUrl}|${location}|${workspaceGeneration}|${mutationsSincePublish}`;
	const validationKey = `${identity}\u0000${mode}\u0000${xmlText}`;
	const importError = activeImportError();

	const updateXml = (value: string) => {
		setXmlText(value);
		setErrors([]);
		setValidated(null);
	};
	const updateMode = (value: ImportMode) => {
		setMode(value);
		setErrors([]);
		setValidated(null);
	};

	const handleValidate = (): RibbonWorkspace | null => {
		const errs = validateRibbonDiffXml(xmlText);
		if (errs.length) {
			setErrors(errs);
			setValidated(null);
			return null;
		}
		try {
			const mismatch = activeImportError();
			if (mismatch) throw new Error(mismatch);
			const store = useRibbonStore.getState();
			const next = applyImportedRibbonXml(
				getEditableWorkspace(store), getBaselineWorkspace(store), xmlText, useSelectionStore.getState().location, mode,
			);
			setErrors([]);
			setValidated(validationKey);
			return next;
		} catch (cause) {
			setErrors([{ message: cause instanceof Error ? cause.message : "Cannot validate this ribbon XML." }]);
			setValidated(null);
			return null;
		}
	};

	const handleImport = () => {
		const next = handleValidate();
		if (!next) return;
		try {
			// One undoable editor transaction. Neither the source snapshot nor the
			// immutable published baseline is replaced (unlike upstream loadRibbons).
			useRibbonStore.getState().applyWorkspaceEdit(next, "Imported ribbon XML");
			setValidated(null);
			closeImportXml();
		} catch (cause) {
			setErrors([{ message: cause instanceof Error ? cause.message : "Could not apply the imported workspace." }]);
			setValidated(null);
		}
	};

	return (
			<Dialog open={importXmlOpen} onOpenChange={(_, data) => { if (!data.open) closeImportXml(); }}>
			<DialogSurface
				style={{ maxWidth: "960px", width: "92vw", height: "80vh", maxHeight: "860px" }}
			>
				<DialogTitle>Import RibbonDiffXml</DialogTitle>
				<DialogBody style={{ height: "100%", display: "flex", flexDirection: "column" }}>
					<DialogContent
						style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
					>
							<TabList
								selectedValue={mode}
								onTabSelect={(_, d) => updateMode(d.value as ImportMode)}
						>
							<Tab value="replace">Replace current</Tab>
							<Tab value="append">Merge / append</Tab>
						</TabList>
							<Divider style={{ margin: "8px 0" }} />
							{mode === "replace" && (
								<MessageBar intent="warning"><MessageBarBody>
									Replace current will discard all unsaved workspace edits across ribbon locations and definitions before applying this XML. The published baseline stays intact, and the edit is undoable.
								</MessageBarBody></MessageBar>
							)}
							{importError && <MessageBar intent="warning"><MessageBarBody>{importError}</MessageBarBody></MessageBar>}
							{!sourceSnapshot && !importError && (
								<MessageBar intent="warning"><MessageBarBody>
									No exported unmanaged solution source is loaded. You can inspect and import into this local editor workspace, but you cannot publish until a matching source is exported.
								</MessageBarBody></MessageBar>
							)}

						<div style={{ flex: 1, minHeight: 0 }}>
							<MonacoEditor
								language="xml"
								value={xmlText}
									onChange={updateXml}
								readOnly={false}
								height="100%"
								options={{
									wordWrap: "on",
									lineNumbers: "on",
									padding: { top: 8 },
								}}
							/>
						</div>

						{errors.length > 0 && (
							<div
								style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}
							>
								{errors.map((err, i) => (
									<MessageBar key={i} intent="error">
										<MessageBarBody>
											{err.message}
											{err.lineHint ? ` (${err.lineHint})` : ""}
										</MessageBarBody>
									</MessageBar>
								))}
							</div>
						)}

							{errors.length === 0 && validated === validationKey && (
							<MessageBar intent="success">
								<MessageBarBody>XML is valid.</MessageBarBody>
							</MessageBar>
						)}
					</DialogContent>
					<DialogActions>
						<Button appearance="secondary" onClick={closeImportXml}>
							Cancel
						</Button>
						<Button appearance="secondary" onClick={handleValidate} disabled={!xmlText.trim()}>
							Validate
						</Button>
							<Button appearance="primary" onClick={handleImport} disabled={!xmlText.trim() || !!importError}>
							Import
						</Button>
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
};

export default ImportXmlModal;
