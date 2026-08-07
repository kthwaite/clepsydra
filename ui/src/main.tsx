import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "#/components/ThemeProvider";
import { EncryptionProvider } from "#/crypto/EncryptionProvider";
import { queryClient } from "#/lib/queryClient";
import { routeTree } from "./routeTree.gen";
import "./main.css";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultStaleTime: 5000,
  scrollRestoration: true,
  defaultViewTransition: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <EncryptionProvider>
          <ThemeProvider>
            <RouterProvider router={router} />
          </ThemeProvider>
        </EncryptionProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
