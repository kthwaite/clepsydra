import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";

const meta: Meta<typeof Dialog> = {
  title: "UI/Dialog",
  component: Dialog,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          isOpen={open}
          onOpenChange={setOpen}
          title="Create Note"
          description="Create a new markdown page."
        >
          <p className="text-sm">Dialog body content goes here.</p>
        </Dialog>
      </>
    );
  },
};

export const WithFooter: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Open dialog</Button>
        <Dialog
          isOpen={open}
          onOpenChange={setOpen}
          title="Confirm Action"
          footer={
            <>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onPress={() => setOpen(false)}>
                Confirm
              </Button>
            </>
          }
        >
          <p className="text-sm">Are you sure you want to proceed?</p>
        </Dialog>
      </>
    );
  },
};

export const Large: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onPress={() => setOpen(true)}>Open large dialog</Button>
        <Dialog isOpen={open} onOpenChange={setOpen} title="Settings" size="lg">
          <p className="text-sm">Large dialog content.</p>
        </Dialog>
      </>
    );
  },
};
