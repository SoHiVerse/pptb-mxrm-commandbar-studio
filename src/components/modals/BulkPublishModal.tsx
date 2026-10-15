import React from "react";
import {
	Badge,
	Button,
	Checkbox,
	Dialog,
	DialogActions,
	DialogBody,
	DialogContent,
	DialogSurface,
	DialogTitle,
	Dropdown,
	Field,
	Input,
	MessageBar,
	MessageBarBody,
	Option,
	ProgressBar,
	Switch,
	Textarea,
	Text,
	makeStyles,
	tokens,
} from "@fluentui/react-components";
import { useRibbonPublishController } from "@/hooks/useRibbonPublishController";

const useStyles = makeStyles({
	content: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.spacingVerticalM,
	},
	entityList: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.spacingVerticalXS,
		maxHeight: "240px",
		overflowY: "auto",
		border: `1px solid ${tokens.colorNeutralStroke2}`,
		borderRadius: tokens.borderRadiusMedium,
		padding: tokens.spacingVerticalXS,
	},
	progressList: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.spacingVerticalXS,
	},
	progressRow: {
		display: "flex",
		alignItems: "center",
		gap: tokens.spacingHorizontalS,
	},
});

export const BulkPublishModal: React.FC = () => {
	const styles = useStyles();
	const {
		bulkPublishOpen, closeBulkPublish, openXmlDrawer,
		activeSolution, activeEntity, entities, selectedEntities,
		selectLoadedEntity, deselectAll, toggleEntity,
		includeApplicationRibbon, setIncludeApplicationRibbon, solutionSupportsAppRibbon, applicationEdited,
		publishing, statusMap, done, incrementSolutionVersion, setIncrementSolutionVersion,
		publishStrategy, selectStrategy, supportsAllAsync, globalConsent, setGlobalConsent,
		progressMessage, publishComment, setPublishComment, solutionVersion, setSolutionVersion, nextVersion,
		errorMessages, mutationsSincePublish, outcome, recovery, importJobId, downloadRecovery,
		reason, canPublish, canDownload, handlePublish, handleClose,
	} = useRibbonPublishController();

	return (
			<Dialog open={bulkPublishOpen} onOpenChange={(_, data) => { if (!data.open && !publishing) handleClose(); }}>
			<DialogSurface
				style={{
					maxWidth: "640px",
					// Cap the surface height to the viewport so the dialog never
					// overflows the screen (the entity checkbox list + strategy
					// dropdown + version field + publish comment can push past
					// the bottom on shorter PPTB layouts). The inner content
					// scrolls instead.
					maxHeight: "92vh",
					display: "flex",
					flexDirection: "column",
				}}
			>
				<DialogTitle>Publish to Dataverse</DialogTitle>
				<DialogBody style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
					<DialogContent style={{ overflowY: "auto", maxHeight: "100%" }}>
						<div className={styles.content}>
							{!activeSolution && (
								<MessageBar intent="warning">
									<MessageBarBody>
										No solution selected. Please select a solution first.
									</MessageBarBody>
								</MessageBar>
							)}

							<MessageBar intent="info">
								<MessageBarBody>
										The selected workspace is verified before any import. Changes appear after a Dynamics
										page reload. You have <strong>{mutationsSincePublish}</strong>{" "}
									change(s) since last publish.
								</MessageBarBody>
							</MessageBar>

							{errorMessages.length > 0 && (
								<MessageBar intent="error" layout="multiline">
									<MessageBarBody>
										<strong>
											Publish failed ({errorMessages.length} error
											{errorMessages.length !== 1 ? "s" : ""})
										</strong>
										<ul style={{ margin: `${tokens.spacingVerticalXS} 0 0`, paddingLeft: 20 }}>
											{errorMessages.map((e, i) => (
												<li key={i} style={{ fontFamily: tokens.fontFamilyMonospace }}>
													<strong>{e.scope}:</strong> {e.message}
												</li>
											))}
										</ul>
										<div style={{ marginTop: tokens.spacingVerticalS }}>
											Full details are in the <strong>Console</strong> tab of the bottom panel.
										</div>
										</MessageBarBody>
									</MessageBar>
								)}

								{reason && (
									<MessageBar intent="warning">
										<MessageBarBody>{reason}</MessageBarBody>
									</MessageBar>
								)}

							{!publishing && !done && (
								<>
									<Text weight="semibold">Select tables to publish:</Text>
									<div style={{ display: "flex", gap: tokens.spacingHorizontalS }}>
										<Button
											appearance="subtle"
											size="small"
												onClick={selectLoadedEntity}
												title="Select only the table loaded in this editor workspace"
										>
											Select all
										</Button>
										<Button
											appearance="subtle"
											size="small"
												onClick={deselectAll}
										>
											Deselect all
										</Button>
									</div>
									<div className={styles.entityList}>
										{entities.map((entity) => (
											<Checkbox
												key={entity.logicalName}
												label={`${entity.displayName || entity.logicalName} (${entity.logicalName})`}
													checked={selectedEntities.includes(entity.logicalName)}
													disabled={entity.logicalName !== activeEntity?.logicalName}
													title={entity.logicalName !== activeEntity?.logicalName ? "Load this table in the editor before publishing it" : undefined}
													onChange={() => toggleEntity(entity.logicalName)}
											/>
											))}
										</div>
										<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
											Other tables remain visible but cannot be published until loaded in this workspace.
										</Text>
									<div>
										<Checkbox
											label="Include Application Ribbon"
											checked={includeApplicationRibbon && solutionSupportsAppRibbon}
												disabled={!solutionSupportsAppRibbon || publishing}
												onChange={(_, d) => setIncludeApplicationRibbon(d.checked === true)}
											/>
											{applicationEdited && !includeApplicationRibbon && (
												<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
													Application ribbon edits require explicitly selecting Include Application Ribbon.
												</Text>
											)}
										{!solutionSupportsAppRibbon && (
											<Text
												size={100}
												style={{
													color: tokens.colorNeutralForeground3,
													display: "block",
													marginLeft: 28,
													marginTop: 2,
												}}
											>
												This solution doesn't include the Application Ribbon component. In
												maker.powerapps.com, open the solution and choose{" "}
												<strong>Add existing → Application Ribbons</strong>, then reload here.
											</Text>
										)}
									</div>
									<Field label="Publish strategy">
										<Dropdown
												selectedOptions={[publishStrategy]}
												disabled={publishing}
												onOptionSelect={(_, data) => {
													if (data.optionValue === "targeted" || data.optionValue === "allAsync") {
														selectStrategy(data.optionValue);
												}
											}}
										>
											<Option value="targeted">Targeted publish (PublishXml)</Option>
												<Option value="allAsync" disabled={!supportsAllAsync}>Async publish all (PublishAllXmlAsync)</Option>
											</Dropdown>
										</Field>
										{!supportsAllAsync && (
											<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
												Asynchronous publish all is unavailable in this organization.
											</Text>
										)}
									<MessageBar intent="info">
										<MessageBarBody>
											{publishStrategy === "targeted"
													? "Targeted mode publishes the loaded table and explicitly included Application ribbon using PublishXml."
													: "Async mode runs PublishAllXmlAsync and tracks the background system job."}
											</MessageBarBody>
										</MessageBar>
										{publishStrategy === "allAsync" && (
											<>
												<MessageBar intent="warning">
													<MessageBarBody>
														<strong>Organization-wide scope:</strong> This publishes all customizations, including unrelated solutions and tables.
													</MessageBarBody>
												</MessageBar>
												<Checkbox
													label="I understand this publishes all customizations in the organization"
													checked={globalConsent}
													disabled={publishing}
													onChange={(_, d) => setGlobalConsent(d.checked === true)}
												/>
											</>
										)}
									<Field label="Solution version">
										<Input
											size="small"
											value={incrementSolutionVersion ? nextVersion : solutionVersion}
											onChange={(_, d) => setSolutionVersion(d.value)}
												disabled={incrementSolutionVersion || publishing}
										/>
									</Field>
									<Switch
										label="Increment solution version"
											checked={incrementSolutionVersion}
											disabled={publishing}
											onChange={(_, d) => setIncrementSolutionVersion(d.checked === true)}
									/>
										<Checkbox
											label="Publish dependencies (commands, rules, web resources)"
											checked={false}
											disabled
											title="No broad dependency publish. Referenced ribbon commands and rules are included in the scoped ZIP."
										/>
										<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
											The scoped ZIP includes ribbon commands and rules; unrelated web resources are not published automatically.
										</Text>
									<Field label="Publish comment">
										<Textarea
											resize="vertical"
											value={publishComment}
											onChange={(_, d) => setPublishComment(d.value)}
										/>
										</Field>
										<Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
											This comment is a local note; it is not sent to Dataverse by the ribbon publishing API.
										</Text>
									<Button
										appearance="subtle"
										onClick={() => {
											openXmlDrawer();
											closeBulkPublish();
										}}
									>
										View RibbonDiffXml
									</Button>
								</>
							)}

							{(publishing || done) && (
								<div className={styles.progressList}>
									{[...selectedEntities, ...(includeApplicationRibbon ? ["Application"] : [])].map(
										(target) => {
											const status = statusMap[target] ?? "pending";
											return (
												<div key={target} className={styles.progressRow}>
													<Badge
														appearance="filled"
														color={
															status === "success"
																? "success"
																: status === "error"
																	? "danger"
																	: status === "publishing"
																		? "informative"
																		: "subtle"
														}
														size="small"
													>
															{outcome === "downloaded" && status === "success" ? "downloaded" : status}
													</Badge>
													<Text>{target}</Text>
													{status === "publishing" && (
														<ProgressBar thickness="large" style={{ flex: 1 }} />
													)}
												</div>
											);
										},
									)}
									{progressMessage && (
										<MessageBar intent="info">
											<MessageBarBody>{progressMessage}</MessageBarBody>
										</MessageBar>
									)}
										</div>
								)}

								{recovery && (
									<MessageBar intent="info">
										<MessageBarBody>
											<strong>Pre-change recovery ZIP available:</strong> {recovery.solutionUniqueName} / {recovery.entityLogicalName}
											{" "}({recovery.organizationUrl}). Keep this package for manual recovery; it is never imported automatically.
											<Button appearance="secondary" size="small" disabled={publishing} onClick={downloadRecovery}>
												Download recovery ZIP
											</Button>
										</MessageBarBody>
									</MessageBar>
								)}
								{importJobId && <Text size={100}>Import job: {importJobId}</Text>}
						</div>
					</DialogContent>
					<DialogActions>
						<Button appearance="secondary" onClick={handleClose} disabled={publishing}>
							{done ? "Close" : "Cancel"}
						</Button>
						{!done && (
							<>
								<Button
									appearance="secondary"
									onClick={() => void handlePublish("save")}
										disabled={!canDownload}
										title="Prepare and download a local solution ZIP. Does not import or publish anything to the server."
									>
										Save ZIP locally
								</Button>
								<Button
									appearance="primary"
									onClick={() => void handlePublish("publish")}
										disabled={!canPublish}
								>
									{publishing
										? "Publishing..."
										: `Publish (${selectedEntities.length + (includeApplicationRibbon ? 1 : 0)})`}
								</Button>
							</>
						)}
					</DialogActions>
				</DialogBody>
			</DialogSurface>
		</Dialog>
	);
};

export default BulkPublishModal;
