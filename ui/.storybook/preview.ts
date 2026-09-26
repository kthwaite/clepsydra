import type { Preview } from "@storybook/react-vite";
import { createElement } from "react";
import "../src/main.css";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "bone",
      values: [
        { name: "charcoal", value: "#151412" },
        { name: "bone", value: "#f4efe4" },
      ],
    },
  },
  decorators: [
    (Story, context) => {
      // Mirror the app: charcoal is the base palette; the "bone" toolbar bg
      // also flips the document to light mode so components render in-context.
      const paper = context.globals.backgrounds?.value !== "#151412";
      document.documentElement.classList.toggle("paper", paper);
      return createElement(
        "div",
        {
          className: "cl-root",
          style: {
            background: "var(--ground)",
            color: "var(--ink)",
            padding: "24px",
            minHeight: "100vh",
          },
        },
        createElement(Story),
      );
    },
  ],
};

export default preview;
