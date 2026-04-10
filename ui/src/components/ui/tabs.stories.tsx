import type { Meta, StoryObj } from "@storybook/react";
import { Tab, TabList, TabPanel, Tabs } from "#/components/ui/tabs";

const meta: Meta<typeof Tabs> = {
  title: "UI/Tabs",
  component: Tabs,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs>
      <TabList aria-label="Agenda">
        <Tab id="today">Today</Tab>
        <Tab id="upcoming">Upcoming</Tab>
        <Tab id="inbox">Inbox</Tab>
      </TabList>
      <div className="mt-4">
        <TabPanel id="today">
          <p className="text-sm">Today panel content</p>
        </TabPanel>
        <TabPanel id="upcoming">
          <p className="text-sm">Upcoming panel content</p>
        </TabPanel>
        <TabPanel id="inbox">
          <p className="text-sm">Inbox panel content</p>
        </TabPanel>
      </div>
    </Tabs>
  ),
};
