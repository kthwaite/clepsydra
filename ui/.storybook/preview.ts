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
      default: "vessel-dark",
      values: [
        { name: "vessel-dark", value: "#0a0a0a" },
        { name: "vessel-paper", value: "#efece2" },
      ],
    },
  },
  decorators: [
    (Story, context) => {
      // Mirror the app: dark is the base palette; the "paper" toolbar bg also
      // flips the document to light mode so components render in-context.
      const paper = context.globals.backgrounds?.value === "#efece2";
      document.documentElement.classList.toggle("paper", paper);
      return createElement(
        "div",
        {
          className: "cl-root",
          style: {
            background: "var(--paper)",
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
