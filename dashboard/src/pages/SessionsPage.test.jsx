import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessions } from "../lib/sessions-api";
import { SessionsPage } from "./SessionsPage.jsx";

vi.mock("../lib/sessions-api", () => ({
  getSessions: vi.fn(),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: () => true,
}));

vi.mock("../ui/components/Toast.jsx", () => ({
  showToast: vi.fn(),
}));

const response = {
  from: "",
  to: "",
  available: true,
  session_count: 2,
  returned_count: 2,
  sessions: [
    {
      session_hash: "claude-row",
      session_id: "11111111-2222-3333-4444-555555555555",
      title: "Fix authentication flow",
      source: "claude",
      project_key: "tokentracker",
      project_ref: "/work/tokentracker",
      model: "claude-opus-4-8",
      started_at: "2026-07-24T08:00:00Z",
      ended_at: "2026-07-24T08:10:00Z",
      duration_ms: 600_000,
      turns: 1,
      edit_turns: 1,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 12_000,
      cost_usd: 0.25,
      productive: true,
      first_pass: true,
      resume_command: "claude --resume 11111111-2222-3333-4444-555555555555",
    },
    {
      session_hash: "codex-row",
      session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Review release",
      source: "codex",
      project_key: "lumaradio",
      project_ref: "/work/lumaradio",
      model: "gpt-5.6-sol",
      started_at: "2026-07-23T08:00:00Z",
      ended_at: "2026-07-23T08:20:00Z",
      duration_ms: 1_200_000,
      turns: 2,
      edit_turns: 0,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 8_000,
      cost_usd: 0.1,
      productive: false,
      first_pass: false,
      resume_command: "codex resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
  ],
};

describe("SessionsPage", () => {
  beforeEach(() => {
    getSessions.mockReset();
    getSessions.mockResolvedValue(response);
    window.localStorage.clear();
  });

  it("loads local sessions and filters them by source and search", async () => {
    render(<SessionsPage />);

    expect(await screen.findByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();
    expect(getSessions).toHaveBeenCalledWith({
      limit: 500,
      from: "",
      refresh: false,
    });

    const sourceTabs = within(screen.getByRole("tablist", { name: "Filter by session source" }));
    fireEvent.click(sourceTabs.getByRole("tab", { name: "Codex" }));
    expect(screen.queryByText("Fix authentication flow")).not.toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();

    fireEvent.click(sourceTabs.getByRole("tab", { name: "All" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "auth" },
    });
    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.queryByText("Review release")).not.toBeInTheDocument();
  });

  it("uses an inclusive seven-day backend range", async () => {
    const expectedFrom = new Date();
    expectedFrom.setDate(expectedFrom.getDate() - 6);
    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");
    fireEvent.click(screen.getByRole("tab", { name: "7d" }));

    await waitFor(() => {
      expect(getSessions).toHaveBeenLastCalledWith({
        limit: 500,
        from: expectedFrom.toISOString().slice(0, 10),
        refresh: false,
      });
    });
  });
});
