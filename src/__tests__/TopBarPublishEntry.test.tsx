import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TopBar } from "@/components/shell/TopBar";
import { useUIStore } from "@/store/uiStore";

function renderTopBar() {
	return render(
		<FluentProvider theme={webLightTheme}>
			<TopBar />
		</FluentProvider>,
	);
}

beforeEach(() => {
	act(() => useUIStore.setState({ bulkPublishOpen: false }));
});

afterEach(async () => {
	// Detach the Fluent controls before resetting the shared store; otherwise
	// mounted Zustand consumers receive updates outside React's act boundary.
	await act(async () => cleanup());
	useUIStore.setState({ bulkPublishOpen: false });
});

describe("Upstream TopBar publish dialog entry points", () => {
	it("Save preserves the upstream label and opens the existing dialog without writing", () => {
		renderTopBar();
		const entry = screen.getByRole("button", { name: "Save" });
		expect(useUIStore.getState().bulkPublishOpen).toBe(false);
		fireEvent.click(entry);
		expect(useUIStore.getState().bulkPublishOpen).toBe(true);
	});

	it("Publish All preserves the upstream label and opens the existing dialog only", () => {
		renderTopBar();
		const entry = screen.getByRole("button", { name: "Publish All" });
		expect(useUIStore.getState().bulkPublishOpen).toBe(false);
		fireEvent.click(entry);
		expect(useUIStore.getState().bulkPublishOpen).toBe(true);
	});
});
