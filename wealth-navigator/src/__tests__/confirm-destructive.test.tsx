/// <reference types="@testing-library/jest-dom" />
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ConfirmDestructive,
  buildConfirmationPhrase,
  type DestructivePreviewItem,
} from "@/components/oems/confirm-destructive";

const SAMPLE_ITEMS: DestructivePreviewItem[] = [
  { id: "ORD-1001", primary: "BUY 1,000 NPN", secondary: "@ 4182.50 · JSE" },
  { id: "ORD-1002", primary: "SELL 500 AGL",  secondary: "@ 124.10 · JSE" },
  { id: "ORD-1003", primary: "BUY 2,500 CFR",  secondary: "@ 67.80 · JSE" },
];

function renderHarness(props: Partial<React.ComponentProps<typeof ConfirmDestructive>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const utils = render(
    <ConfirmDestructive
      count={3}
      label="CANCEL 3 ORDERS"
      triggerLabel="Cancel working"
      triggerVariant="outline"
      onConfirm={onConfirm}
      previewItems={SAMPLE_ITEMS}
      {...props}
    />,
  );
  return { onConfirm, ...utils };
}

describe("buildConfirmationPhrase", () => {
  it("uses the first token of label uppercased followed by count", () => {
    expect(buildConfirmationPhrase(3, "CANCEL 3 ORDERS")).toBe("CANCEL 3");
  });

  it("uppercases a lowercase verb", () => {
    expect(buildConfirmationPhrase(1, "Cancel")).toBe("CANCEL 1");
  });

  it("produces a unique-enough phrase for a single order (count of 1)", () => {
    expect(buildConfirmationPhrase(1, "CANCEL 1 ORDER")).toBe("CANCEL 1");
  });

  it("falls back to CONFIRM when label is empty", () => {
    expect(buildConfirmationPhrase(5, "")).toBe("CONFIRM 5");
  });
});

describe("ConfirmDestructive", () => {
  it("renders the trigger button with the trigger label and the count badge", () => {
    renderHarness();
    const trigger = screen.getByTestId("confirm-destructive-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent("Cancel working");
    expect(trigger).toHaveTextContent("3");
  });

  it("disables the trigger when disabled or when count is 0", () => {
    const a = renderHarness({ disabled: true });
    expect(screen.getByTestId("confirm-destructive-trigger")).toBeDisabled();
    a.unmount();

    renderHarness({ count: 0 });
    expect(screen.getByTestId("confirm-destructive-trigger")).toBeDisabled();
  });

  it("does not render the destructive action or the preview list until opened", () => {
    renderHarness();
    expect(screen.queryByTestId("confirm-destructive-submit")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("ORD-1001")).not.toBeInTheDocument();
  });

  it("opens the dialog and lists every preview item when the trigger is clicked", async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("confirm-destructive-trigger"));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("CANCEL 3 ORDERS");
    expect(dialog).toHaveTextContent("This action is irreversible");

    for (const it of SAMPLE_ITEMS) {
      expect(dialog).toHaveTextContent(it.id);
      expect(dialog).toHaveTextContent(it.primary);
    }
  });

  it("disables the destructive submit button until the user types the exact phrase", async () => {
    renderHarness();
    fireEvent.click(screen.getByTestId("confirm-destructive-trigger"));

    const submit = await screen.findByTestId("confirm-destructive-submit");
    expect(submit).toBeDisabled();

    const input = screen.getByTestId("confirm-destructive-input");
    fireEvent.change(input, { target: { value: "CANCEL 2" } });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "  CANCEL 3  " } });
    // Whitespace-padded match should still arm.
    expect(submit).not.toBeDisabled();
  });

  it("fires onConfirm exactly once when the correct phrase is typed and submit is clicked", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderHarness({ onConfirm });
    fireEvent.click(screen.getByTestId("confirm-destructive-trigger"));

    const input = await screen.findByTestId("confirm-destructive-input");
    fireEvent.change(input, { target: { value: "CANCEL 3" } });

    const submit = screen.getByTestId("confirm-destructive-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("does NOT fire onConfirm when the typed phrase is wrong", async () => {
    const onConfirm = vi.fn();
    renderHarness({ onConfirm });
    fireEvent.click(screen.getByTestId("confirm-destructive-trigger"));

    const input = await screen.findByTestId("confirm-destructive-input");
    fireEvent.change(input, { target: { value: "delete" } });

    const submit = screen.getByTestId("confirm-destructive-submit");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes the dialog on successful confirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    renderHarness({ onConfirm });
    fireEvent.click(screen.getByTestId("confirm-destructive-trigger"));

    const input = await screen.findByTestId("confirm-destructive-input");
    fireEvent.change(input, { target: { value: "CANCEL 3" } });
    fireEvent.click(screen.getByTestId("confirm-destructive-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-submit")).not.toBeInTheDocument();
    });
  });
});
