import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRibbonStore } from "@/store/ribbonStore";
import { useSessionStore } from "@/store/sessionStore";

vi.mock("@/components/shell/Layout", () => ({
	Layout: ({ children, rightPane }: { children: ReactNode; rightPane: ReactNode }) => (
		<div data-testid="layout">{children}{rightPane}</div>
	),
}));
vi.mock("@/components/ribbon-canvas/RibbonCanvas", () => ({
	RibbonCanvas: () => <main aria-label="Ribbon canvas" />,
}));
vi.mock("@/components/properties-pane/PropertiesPane", () => ({
	PropertiesPane: () => <aside data-testid="properties-pane" />,
}));
vi.mock("@/components/bottom-panel/BottomPanel", () => ({
	BottomPanel: () => <div data-testid="bottom-panel" />,
}));
vi.mock("@/components/left-pane/TablesPane", () => ({ TablesPane: () => <div /> }));
vi.mock("@/components/left-pane/SolutionElementsPane", () => ({ SolutionElementsPane: () => <div /> }));
vi.mock("@/services/dataverse/solutionService", () => ({
	fetchSolutions: vi.fn(async () => []),
	fetchSolutionEntityIds: vi.fn(async () => []),
	fetchSolutionRibbonComponentIds: vi.fn(async () => []),
}));
vi.mock("@/services/dataverse/userService", () => ({
	fetchCurrentUser: vi.fn(async () => ({ id: "", name: "" })),
}));

import { App } from "@/App";

describe("native and PPTB shared canvas layout", () => {
	beforeEach(() => {
		act(() => {
			useSessionStore.setState({ activeSolution: null, activeEntity: null, connectionUrl: "" });
			useRibbonStore.setState({ workspaceReadOnly: false });
		});
	});
	afterEach(async () => { await act(async () => cleanup()); });

	it("uses the original direct canvas and properties topology without integration wrappers", async () => {
		render(<App />);
		const main = screen.getByRole("main", { name: "Ribbon canvas" });
		expect(main.parentElement).toBe(screen.getByTestId("layout"));
		expect(screen.getByTestId("properties-pane").parentElement).toBe(screen.getByTestId("layout"));
		expect(main.closest("[inert]")).toBeNull();
		expect(screen.getByTestId("properties-pane")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId("layout")).toBeInTheDocument());
	});
});
