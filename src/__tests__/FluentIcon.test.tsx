import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import FluentIcon from "@/components/shared/FluentIcon";
import { useSessionStore } from "@/store/sessionStore";

describe("original FluentIcon web-resource presentation", () => {
	let previousConnection: string;
	beforeEach(() => {
		previousConnection = useSessionStore.getState().connectionUrl;
		act(() => useSessionStore.setState({ connectionUrl: "https://crm.example.test/Org" }));
	});
	afterEach(() => {
		cleanup();
		act(() => useSessionStore.setState({ connectionUrl: previousConnection }));
	});

	it("displays the original same-origin web-resource image within existing size, class, style and aria props", () => {
		const { container } = render(
			<FluentIcon
				name="$webresource:Service/_imgs/ribbon/WorkHours.svg"
				size={24}
				className="original-ribbon-icon"
				style={{ filter: "grayscale(40%) opacity(0.85)", marginLeft: "2px" }}
				aria-hidden={false}
			/>,
		);
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		expect(image?.getAttribute("src")).toBe("https://crm.example.test/Org/WebResources/Service/_imgs/ribbon/WorkHours.svg");
		expect(image?.getAttribute("width")).toBe("24");
		expect(image?.getAttribute("height")).toBe("24");
		expect(image?.getAttribute("aria-hidden")).toBe("false");
		expect(image?.classList.contains("original-ribbon-icon")).toBe(true);
		expect(image?.style.filter).toBe("grayscale(40%) opacity(0.85)");
		expect(image?.style.marginLeft).toBe("2px");
	});

	it("falls back to the original generic Fluent icon on a failed resource load", () => {
		const { container } = render(<FluentIcon name="$webresource:Activities/Images/SendAsAppointment_16.png" size={16} className="icon" aria-hidden />);
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		fireEvent.error(image!);
		expect(container.querySelector("img")).toBeNull();
		const fallback = container.querySelector("svg");
		expect(fallback?.getAttribute("data-cbs-icon-fallback")).toBe("true");
		expect(fallback?.getAttribute("aria-hidden")).toBe("true");
		expect(fallback?.classList.contains("icon")).toBe(true);
	});

	it("switching icon resources retries the new image after a failed earlier resource", () => {
		const { container, rerender } = render(<FluentIcon name="$webresource:Service/Old.png" size={16} />);
		fireEvent.error(container.querySelector("img")!);
		expect(container.querySelector("img")).toBeNull();
		rerender(<FluentIcon name="$webresource:Service/New.svg" size={16} />);
		expect(container.querySelector("img")?.getAttribute("src")).toBe("https://crm.example.test/Org/WebResources/Service/New.svg");
	});

	it("uses active connection changes and safely refuses invalid resource URLs", () => {
		const { container, rerender } = render(<FluentIcon name="$webresource:Service/_imgs/ribbon/WorkHours.svg" size={16} />);
		act(() => useSessionStore.setState({ connectionUrl: "https://crm.example.test/Virtual/OtherOrg/" }));
		expect(container.querySelector("img")?.getAttribute("src"))
			.toBe("https://crm.example.test/Virtual/OtherOrg/WebResources/Service/_imgs/ribbon/WorkHours.svg");
		rerender(<FluentIcon name="$webresource:../outside.svg" size={16} />);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector('svg[data-cbs-icon-fallback="true"]')).not.toBeNull();
	});

	it("keeps existing mapped Fluent library icons and their variants unchanged", () => {
		const { container } = render(<FluentIcon name="search" size={20} variant="filled" className="library-icon" />);
		expect(container.querySelector("img")).toBeNull();
		const icon = container.querySelector("svg");
		expect(icon).not.toBeNull();
		expect(icon?.getAttribute("data-cbs-icon-fallback")).toBeNull();
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
		expect(icon?.classList.contains("library-icon")).toBe(true);
	});
});
