/** Capability flags consumed by the shared CBS interface in either host. */
export interface RuntimeCapabilities {
	kind: "pptb" | "onpremises";
	publishAllXmlAsync: boolean;
}

let current: RuntimeCapabilities = { kind: "pptb", publishAllXmlAsync: true };

export function getRuntimeCapabilities(): RuntimeCapabilities {
	return { ...current };
}

/** The existing PPTB host keeps its established publishing behavior. */
export function activatePptbRuntime(): void {
	current = { kind: "pptb", publishAllXmlAsync: true };
}

/** A native optional operation is disabled until its CSDL action is confirmed. */
export function activateOnPremRuntime(publishAllXmlAsync = false): void {
	current = { kind: "onpremises", publishAllXmlAsync };
}
