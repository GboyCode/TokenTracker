import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SearchableSelect } from "./SearchableSelect.jsx";

it("filters options and selects the matching project", () => {
  const onChange = vi.fn();
  render(
    <SearchableSelect
      options={[
        { value: "tokentracker", label: "tokentracker" },
        { value: "lumaradio", label: "lumaradio" },
      ]}
      value="all"
      onChange={onChange}
      allLabel="All projects"
      searchPlaceholder="Search projects"
      emptyLabel="No matching projects"
      ariaLabel="Filter by project"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  fireEvent.change(screen.getByPlaceholderText("Search projects"), {
    target: { value: "luma" },
  });

  expect(screen.queryByRole("button", { name: "tokentracker" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "lumaradio" }));
  expect(onChange).toHaveBeenCalledWith("lumaradio");
});
