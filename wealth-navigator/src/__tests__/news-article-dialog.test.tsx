import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `<NewsArticleDialog/>` — the shared "full read" popup reused by the three
 * news surfaces (strategy News & Insights card, Cockpit news flow,
 * `/oems/news`).
 *
 * Coverage:
 *   - Closed (item null) renders nothing of the article.
 *   - Open renders headline, source, and full available body verbatim.
 *   - Falls back to the headline (and an honest "no full text" note) when
 *     the source only provides a headline — never fabricates body copy.
 *   - Renders an "Open source" link only when the item carries a URL.
 *   - onOpenChange fires when the dialog is dismissed.
 */

import * as React from "react";

import { NewsArticleDialog, type NewsArticleDialogItem } from "../components/oems/primitives/news-article-dialog";

const fullItem: NewsArticleDialogItem = {
  headline: "Naspers rallies on Tencent stake news",
  body: "Naspers shares rose 4% after Tencent reported stronger-than-expected quarterly earnings, boosting sentiment across JSE-listed tech proxies.",
  source: "Moneyweb",
  ts: Date.parse("2026-08-20T09:15:00Z"),
  url: "https://example.com/naspers-rally",
  category: "WIRE",
  tickers: ["NPN"],
  wire: "ALLIANCE",
};

const headlineOnlyItem: NewsArticleDialogItem = {
  headline: "SENS: Trading statement issued",
  body: null,
  source: "SENSD",
  ts: Date.parse("2026-08-20T07:00:00Z"),
  url: null,
  wire: "SENS",
  regulatory: true,
};

describe("<NewsArticleDialog/>", () => {
  it("keeps the API body when Cockpit maps live news into the shared popup", () => {
    const cockpit = readFileSync(resolve("src/app/oems/cockpit-client.tsx"), "utf8");
    expect(cockpit).toContain("body: n.body");
  });

  it("renders nothing when there is no active item", () => {
    const { queryByText } = render(
      <NewsArticleDialog item={null} open={false} onOpenChange={() => {}} />,
    );
    expect(queryByText(fullItem.headline)).not.toBeInTheDocument();
  });

  it("shows the headline, source, and full available body when open", () => {
    const { getByText } = render(
      <NewsArticleDialog item={fullItem} open onOpenChange={() => {}} />,
    );
    expect(getByText(fullItem.headline)).toBeInTheDocument();
    expect(getByText("Moneyweb")).toBeInTheDocument();
    expect(getByText(/Naspers shares rose 4%/)).toBeInTheDocument();
    expect(getByText("Open source")).toBeInTheDocument();
  });

  it("falls back to the headline and an honest gap note when there is no body", () => {
    const { getAllByText, getByText, queryByText } = render(
      <NewsArticleDialog item={headlineOnlyItem} open onOpenChange={() => {}} />,
    );
    expect(getAllByText(headlineOnlyItem.headline).length).toBeGreaterThan(0);
    expect(getByText(/This feed provided only the headline/)).toBeInTheDocument();
    expect(queryByText("Open source")).not.toBeInTheDocument();
  });

  it("directs a headline-only linked item to the publisher without claiming the article does not exist", () => {
    const { getByText, queryByText } = render(
      <NewsArticleDialog
        item={{ ...headlineOnlyItem, url: "https://example.com/full-story" }}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(getByText(/This feed did not provide article text/)).toBeInTheDocument();
    expect(queryByText(/isn't provided by this source/)).not.toBeInTheDocument();
    expect(getByText("Open source")).toBeInTheDocument();
  });

  it("calls onOpenChange when dismissed", () => {
    const onOpenChange = vi.fn();
    const { getByRole } = render(
      <NewsArticleDialog item={fullItem} open onOpenChange={onOpenChange} />,
    );
    fireEvent.click(getByRole("button", { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
