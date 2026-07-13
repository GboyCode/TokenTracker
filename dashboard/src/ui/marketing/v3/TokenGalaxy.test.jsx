import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenGalaxy } from "./TokenGalaxy";
import { DISC, orbScreenPos, orbitSpeedForViewport, sceneConfigForViewport } from "./galaxy-config";

vi.mock("three", () => ({
  WebGLRenderer: vi.fn(() => {
    throw new Error("webgl unavailable");
  }),
}));

describe("TokenGalaxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-renders the static fallback when WebGL renderer creation fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container } = render(<TokenGalaxy mode="full" progressRef={{ current: 0 }} />);

    await waitFor(() => {
      expect(container.firstElementChild).toHaveAttribute("data-mode", "static");
    });
  });

  it("keeps provider orbs visible below the sm breakpoint", () => {
    const { container } = render(<TokenGalaxy mode="static" progressRef={{ current: 0 }} />);
    const providerOrbs = container.querySelectorAll("[data-provider-orb]");

    expect(providerOrbs).toHaveLength(8);
    providerOrbs.forEach((orb) => {
      expect(orb).toHaveClass("flex", "h-10", "w-10", "sm:h-12", "sm:w-12");
      expect(orb).not.toHaveClass("hidden");
    });
  });

  it("uses a clearly perceptible orbit speed on compact viewports", () => {
    expect(orbitSpeedForViewport({ compactViewport: true })).toBe(DISC.mobileOrbitSpeed);
    expect(DISC.mobileOrbitSpeed).toBeGreaterThan(DISC.orbitSpeed * 10);
    expect(orbitSpeedForViewport({ compactViewport: false })).toBe(DISC.orbitSpeed);
  });

  it("keeps the compact orbit centered around the token core", () => {
    const compactPositions = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle) =>
      orbScreenPos(angle, 1, true),
    );

    expect(compactPositions.map(({ top }) => top)).toEqual([50, 35, 50, 65]);
    expect(compactPositions.every(({ left }) => left >= 9 && left <= 91)).toBe(true);
  });

  it("widens the mobile camera while preserving the black-hole focal weight", () => {
    const mobile = sceneConfigForViewport({ compactViewport: true });
    const desktop = sceneConfigForViewport({ compactViewport: false });

    expect(mobile.cameraFov).toBeGreaterThan(desktop.cameraFov);
    expect(mobile.cameraZ).toBeGreaterThan(desktop.cameraZ);
    expect(mobile.pointScale).toBeGreaterThan(1);
    expect(mobile.lensScale).toBeGreaterThan(1);
  });
});
