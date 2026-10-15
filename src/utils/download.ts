/** Build a filename using the identity captured before an asynchronous publish. */
export function ribbonPackageFilename(
	solutionUniqueName: string,
	entityLogicalName: string,
	kind: "prepared" | "recovery",
): string {
	const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 90) || "unknown";
	return `CommandBarStudio_${safe(solutionUniqueName)}_${safe(entityLogicalName)}_${kind}.zip`;
}

/** Download a package locally. This function never calls any Dataverse API. */
export function downloadBase64Zip(base64: string, filename: string): void {
	if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
		throw new Error("The solution ZIP is not valid base64; no file was downloaded.");
	}
	const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body.appendChild(link);
	try {
		link.click();
	} finally {
		link.remove();
		URL.revokeObjectURL(url);
	}
}
