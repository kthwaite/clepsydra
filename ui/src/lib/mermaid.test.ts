import { afterEach, describe, expect, it } from "vitest";
import { diagramThemeVariables } from "#/lib/mermaid";

const root = () => document.documentElement;

describe("diagramThemeVariables", () => {
  afterEach(() => {
    root().removeAttribute("style");
    root().classList.remove("paper");
  });

  it("reads the Stone & Lamp role tokens and the sans face", () => {
    root().style.setProperty("--ground", "#f4efe4");
    root().style.setProperty("--raise", "#fbf8f2");
    root().style.setProperty("--sink", "#eae3d3");
    root().style.setProperty("--mute", "#5f6372");
    root().style.setProperty("--font-sans", "Geist");
    root().classList.add("paper");

    const vars = diagramThemeVariables();

    expect(vars).toMatchObject({
      darkMode: false,
      background: "#f4efe4",
      mainBkg: "#eae3d3",
      clusterBkg: "#fbf8f2",
      lineColor: "#5f6372",
      errorTextColor: "#fbf8f2",
      fontFamily: "Geist",
    });
  });

  it("falls back to charcoal and cobalt without a stylesheet", () => {
    const vars = diagramThemeVariables();
    expect(vars).toMatchObject({
      darkMode: true,
      background: "#151412",
      primaryBorderColor: "#809cff",
    });
    expect(String(vars.fontFamily)).toMatch(/Geist/);
  });
});
