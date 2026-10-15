import { installOnPremHost, type OnPremInstallOptions } from "./onpremHost";

/** Native hosting must initialize window APIs before evaluating ./main.tsx. */
export async function bootstrapOnPrem(
	loadApp: () => Promise<unknown>,
	options?: OnPremInstallOptions,
): Promise<void> {
	try {
		const installed = installOnPremHost(options);
		// CSDL inspection can finish later. Unknown operations remain disabled.
		void installed.ready.catch(() => undefined);
		await loadApp();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const root = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
		root.setAttribute("role", "alert");
		root.textContent = `Command Bar Studio could not start in Dynamics: ${detail}`;
	}
}
