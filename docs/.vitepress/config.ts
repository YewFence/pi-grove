import { defineConfig } from "vitepress";
import { readdirSync } from "node:fs";

const cuesAdrs = readdirSync(new URL("../pi-cues/adrs/", import.meta.url))
  .filter((file) => /^\d+.*\.md$/.test(file))
  .sort()
  .map((file) => ({ text: file.replace(/\.md$/, "").replaceAll("-", " "), link: `/pi-cues/adrs/${file.replace(/\.md$/, "")}` }));

export default defineConfig({
  base: "/pi-grove/",
  title: "pi-grove",
  description: "Independent extensions for the pi coding agent",
  themeConfig: {
    nav: [{ text: "Extensions", link: "/" }, { text: "Development", link: "/development" }, { text: "GitHub", link: "https://github.com/YewFence/pi-grove" }],
    sidebar: [{ text: "pi-grove", items: [{ text: "Overview", link: "/" }, { text: "Development and releases", link: "/development" }, { text: "Monorepo decisions", link: "/adrs/0001-independent-packages" }] }, { text: "pi-cues decisions", items: cuesAdrs }],
    search: { provider: "local" },
  },
});
