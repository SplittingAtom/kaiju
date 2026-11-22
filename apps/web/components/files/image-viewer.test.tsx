// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { IconActionProvider } from "../shell/icon-action";
import { ImageViewer } from "./image-viewer";

/** KOBE-807: the image and SVG viewer of a file tab. */
afterEach(cleanup);

function show(src = "data:image/png;base64,iVBORw==", name = "p.png", size = 2048) {
  render(
    <IconActionProvider>
      <ImageViewer src={src} name={name} size={size} />
    </IconActionProvider>,
  );
  return screen.getByRole("img", { name });
}

/** happy-dom loads no images: give the element its natural size and say it loaded. */
function loaded(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
}

const zoomText = () => screen.getByRole("status", { name: "Zoom" }).textContent;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("image viewer (ac-1)", () => {
  it("shows the pixel dimensions and the file size, over a checkerboard", () => {
    const img = show();
    loaded(img, 640, 480);
    expect(screen.getByText("640 × 480 px · 2 KB")).toBeTruthy();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    expect(img.parentElement?.className).toMatch(/checkerboard/);
    expect(img.style.width).toBe("640px");
  });

  it("fit to width by default; actual size; zoom in and out by mouse and keys", async () => {
    const img = show();
    loaded(img, 400, 200);
    const user = userEvent.setup();
    expect(pressed("Fit to width")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomText()).toBe("110%");
    expect(img.style.width).toBe("440px");
    expect(pressed("Fit to width")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomText()).toBe("90%");
    await user.click(screen.getByRole("button", { name: "Actual size" }));
    expect(pressed("Actual size")).toBe("true");
    expect(zoomText()).toBe("100%");
    screen.getByRole("region", { name: "p.png" }).focus();
    await user.keyboard("{Control>}={/Control}");
    expect(zoomText()).toBe("110%");
    await user.keyboard("{Control>}0{/Control}");
    expect(pressed("Fit to width")).toBe("true");
  });

  it("pans by dragging when zoomed past the column", () => {
    const img = show();
    loaded(img, 4000, 3000);
    const region = screen.getByRole("region", { name: "p.png" });
    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    region.scrollLeft = 100;
    region.scrollTop = 100;
    fireEvent.pointerDown(region, { clientX: 200, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(region, { clientX: 150, clientY: 170, pointerId: 1 });
    expect(region.scrollLeft).toBe(150);
    expect(region.scrollTop).toBe(130);
    fireEvent.pointerUp(region, { pointerId: 1 });
    fireEvent.pointerMove(region, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(region.scrollLeft).toBe(150);
  });

  it("SVG is an image from a data URL, never inline markup; no size until it loads", () => {
    const img = show("data:image/svg+xml;base64,PHN2Zy8+", "logo.svg", 120);
    expect(img.tagName).toBe("IMG");
    expect(document.querySelector("svg:not([aria-hidden])")).toBeNull();
    expect(screen.getByText("120 B")).toBeTruthy();
  });
});
