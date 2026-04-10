import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";

describe("Tabs", () => {
  it("renders tabs and selects first by default", () => {
    render(
      <Tabs>
        <TabList aria-label="Sections">
          <Tab id="a">Alpha</Tab>
          <Tab id="b">Beta</Tab>
        </TabList>
        <TabPanel id="a">Content A</TabPanel>
        <TabPanel id="b">Content B</TabPanel>
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "Alpha" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Beta" })).toBeDefined();
    expect(screen.getByText("Content A")).toBeDefined();
  });

  it("switches tab on click", async () => {
    const user = userEvent.setup();
    render(
      <Tabs>
        <TabList aria-label="Sections">
          <Tab id="a">Alpha</Tab>
          <Tab id="b">Beta</Tab>
        </TabList>
        <TabPanel id="a">Content A</TabPanel>
        <TabPanel id="b">Content B</TabPanel>
      </Tabs>,
    );
    await user.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByText("Content B")).toBeDefined();
  });

  it("applies selected styling to active tab", () => {
    render(
      <Tabs>
        <TabList aria-label="Sections">
          <Tab id="a">Alpha</Tab>
          <Tab id="b">Beta</Tab>
        </TabList>
        <TabPanel id="a">Content A</TabPanel>
        <TabPanel id="b">Content B</TabPanel>
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "Alpha" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("supports controlled selectedKey", () => {
    render(
      <Tabs selectedKey="b">
        <TabList aria-label="Sections">
          <Tab id="a">Alpha</Tab>
          <Tab id="b">Beta</Tab>
        </TabList>
        <TabPanel id="a">Content A</TabPanel>
        <TabPanel id="b">Content B</TabPanel>
      </Tabs>,
    );
    expect(screen.getByText("Content B")).toBeDefined();
  });
});
