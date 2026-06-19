import { createFileRoute } from "@tanstack/react-router";
import { factsheetsHTML } from "../factsheets-content";

export const Route = createFileRoute("/factsheets")({
  head: () => ({
    meta: [
      { title: "Factsheets — Mint" },
      { name: "description", content: "Premium fintech strategy factsheets." },
      { property: "og:title", content: "Factsheets — Mint" },
      { property: "og:description", content: "Premium fintech strategy factsheets." },
    ],
  }),
  component: FactsheetsPage,
});

function FactsheetsPage() {
  return (
    <iframe
      title="Factsheets"
      srcDoc={factsheetsHTML}
      style={{ border: 0, width: "100vw", height: "100vh", display: "block" }}
    />
  );
}