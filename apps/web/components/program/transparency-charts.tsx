"use client";

import { type AgCartesianChartOptions, AllCommunityModule, ModuleRegistry } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { Component, type ReactNode, useEffect, useMemo, useState } from "react";
import type { TransparencyStats } from "@/lib/server/stats";

/** A chart that throws must never take the program page down: the tiles above carry the same numbers. */
class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// AG Charts 14 is modular: without this the chart throws "No modules have been registered" at runtime.
ModuleRegistry.registerModules([AllCommunityModule]);

type Palette = { success: string; danger: string; info: string; warning: string; seal: string; text: string; muted: string; grid: string; font: string };

const TOKENS: Record<Exclude<keyof Palette, "font">, string> = {
  success: "--success",
  danger: "--destructive",
  info: "--chart-1",
  warning: "--warning",
  seal: "--seal-strong",
  text: "--foreground",
  muted: "--muted-foreground",
  grid: "--chart-grid",
};

/** Resolve a CSS colour (oklch included) to rgb by painting one pixel, since the chart canvas cannot read var(). */
function toRgb(ctx: CanvasRenderingContext2D, value: string): string {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

function readPalette(): Palette | null {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const style = getComputedStyle(document.documentElement);
  const out: Partial<Palette> = { font: style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif" };
  for (const [key, token] of Object.entries(TOKENS)) out[key as keyof typeof TOKENS] = toRgb(ctx, style.getPropertyValue(token).trim() || "#888");
  return out as Palette;
}

/** The palette follows the app theme: next-themes toggles a class on <html>, so watch it. */
function usePalette(): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => {
    const update = () => setPalette(readPalette());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="h-[220px] px-2 py-2">{children}</div>
    </div>
  );
}

export function TransparencyCharts({ stats }: { stats: TransparencyStats }) {
  const p = usePalette();

  const verdictOptions = useMemo(() => {
    if (!p) return null;
    return {
      background: { visible: false },
      padding: { top: 4, right: 8, bottom: 4, left: 8 },
      data: [
        { verdict: "Reproduced", count: stats.reproduced },
        { verdict: "Slop", count: stats.slop },
        { verdict: "Duplicate", count: stats.duplicates },
        { verdict: "Needs a human", count: stats.needsHuman },
      ],
      series: [
        {
          type: "donut" as const,
          angleKey: "count",
          legendItemKey: "verdict",
          calloutLabelKey: "verdict",
          fills: [p.success, p.danger, p.info, p.warning],
          strokeWidth: 0,
          innerRadiusRatio: 0.66,
          calloutLabel: { enabled: false },
          innerLabels: [
            { text: String(stats.triaged), fontSize: 26, fontWeight: 600, color: p.text, fontFamily: p.font },
            { text: "triaged", fontSize: 12, color: p.muted, fontFamily: p.font, spacing: 4 },
          ],
          tooltip: { renderer: ({ datum }: { datum: { verdict: string; count: number } }) => ({ heading: datum.verdict, data: [{ label: "Reports", value: String(datum.count) }] }) },
        },
      ],
      legend: { position: "right" as const, item: { label: { color: p.muted, fontSize: 12, fontFamily: p.font }, marker: { size: 8 } } },
    };
  }, [p, stats.reproduced, stats.slop, stats.duplicates, stats.needsHuman, stats.triaged]);

  const moneyOptions = useMemo((): AgCartesianChartOptions | null => {
    if (!p) return null;
    const amount = (m: { value: string }) => Number(m.value) || 0;
    const axisText = { color: p.muted, fontSize: 12, fontFamily: p.font };
    return {
      background: { visible: false },
      padding: { top: 8, right: 16, bottom: 4, left: 8 },
      data: [
        { label: "Held", amount: amount(stats.depositsHeld.total), fill: p.warning },
        { label: "Released", amount: amount(stats.depositsReleased.total), fill: p.info },
        { label: "Captured", amount: amount(stats.depositsCaptured.total), fill: p.danger },
        { label: "Paid out", amount: amount(stats.bountiesPaid.total), fill: p.success },
      ],
      series: [
        {
          type: "bar" as const,
          direction: "horizontal" as const,
          xKey: "label",
          yKey: "amount",
          yName: "USD",
          cornerRadius: 4,
          itemStyler: ({ datum }: { datum: { fill: string } }) => ({ fill: datum.fill }),
          // Zero bars have no room for a label, and the axis already says $0.
          label: { enabled: true, color: p.text, fontSize: 12, fontFamily: p.font, formatter: ({ value }: { value: number }) => (value > 0 ? usd.format(value) : "") },
          tooltip: { renderer: ({ datum }: { datum: { label: string; amount: number } }) => ({ heading: datum.label, data: [{ label: "Total", value: usd.format(datum.amount) }] }) },
        },
      ],
      axes: {
        x: { type: "category" as const, position: "left" as const, line: { enabled: false }, tick: { enabled: false }, label: axisText },
        y: {
          type: "number" as const,
          position: "bottom" as const,
          line: { enabled: false },
          tick: { enabled: false },
          gridLine: { style: [{ stroke: p.grid, lineDash: [] as number[] }] },
          label: { ...axisText, formatter: ({ value }: { value: number }) => usdWhole.format(value) },
        },
      },
      legend: { enabled: false },
    };
  }, [p, stats.depositsHeld.total, stats.depositsReleased.total, stats.depositsCaptured.total, stats.bountiesPaid.total]);

  if (stats.triaged === 0) {
    return (
      <div className="rounded-xl bg-card px-4 py-6 ring-1 ring-foreground/10">
        <p className="text-sm text-muted-foreground">No reports yet. Charts appear after the first verdict.</p>
      </div>
    );
  }

  return (
    <ChartBoundary>
      <div className="grid gap-3 md:grid-cols-2">
        <ChartCard title="Verdicts">{verdictOptions && <AgCharts options={verdictOptions} style={{ height: "100%" }} />}</ChartCard>
        <ChartCard title="Where the money went">{moneyOptions && <AgCharts options={moneyOptions} style={{ height: "100%" }} />}</ChartCard>
      </div>
    </ChartBoundary>
  );
}
