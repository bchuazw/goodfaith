"use client";

import { AllCommunityModule, type ColDef, type ICellRendererParams, ModuleRegistry, type RowClickedEvent, themeQuartz } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { SearchIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Money } from "@/components/money";
import { DepositBadge, PayoutBadge, ReportStatusBadge, SeverityLabel, VerdictBadge } from "@/components/status";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/client/api";
import { useClientNow } from "@/lib/client/use-client-now";
import { formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { QueueRow } from "@/lib/view-types";

ModuleRegistry.registerModules([AllCommunityModule]);

/** The grid follows the app's tokens, so it is right in light and dark without a second theme. */
const gridTheme = themeQuartz.withParams({
  backgroundColor: "var(--card)",
  foregroundColor: "var(--foreground)",
  headerBackgroundColor: "var(--surface-raised)",
  headerTextColor: "var(--muted-foreground)",
  borderColor: "var(--border)",
  rowBorder: { color: "var(--border)" },
  rowHoverColor: "color-mix(in oklch, var(--accent) 70%, transparent)",
  selectedRowBackgroundColor: "var(--accent)",
  accentColor: "var(--primary)",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 500,
  wrapperBorderRadius: 12,
  spacing: 7,
  rowHeight: 58,
  headerHeight: 38,
  oddRowBackgroundColor: "transparent",
  columnBorder: false,
});

type Filter = "decide" | "triage" | "settled" | "all";

const FILTERS: Array<{ id: Filter; label: string; test: (r: QueueRow) => boolean }> = [
  { id: "decide", label: "Needs a decision", test: (r) => r.status === "triaged" || r.status === "triage_failed" || r.settlement?.status === "failed" },
  { id: "triage", label: "In triage", test: (r) => r.status === "queued" || r.status === "triaging" || r.status === "awaiting_deposit" },
  { id: "settled", label: "Settled", test: (r) => r.status === "settled" },
  { id: "all", label: "All", test: () => true },
];

function ReportCell({ data }: ICellRendererParams<QueueRow>) {
  if (!data) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <Link href={`/console/r/${data.id}`} className="truncate font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
        {data.title}
      </Link>
      <span className="mt-0.5 flex items-center gap-2 font-mono text-[0.7rem] text-muted-foreground">
        {data.id}
        {data.demoScenario && <span className="rounded bg-muted px-1 font-sans">judge mode</span>}
      </span>
    </div>
  );
}

const cell = (node: React.ReactNode) => <div className="flex h-full items-center">{node}</div>;

export function QueueGrid({ initial }: { initial: QueueRow[] }) {
  const router = useRouter();
  const now = useClientNow();
  const [rows, setRows] = useState(initial);
  const [filter, setFilter] = useState<Filter>(() => (initial.some(FILTERS[0]?.test ?? (() => false)) ? "decide" : "all"));
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api<{ rows: QueueRow[] }>("/api/reports")
        .then((r) => setRows(r.rows))
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter(f.test).length])) as Record<Filter, number>, [rows]);
  const visible = useMemo(() => rows.filter((FILTERS.find((f) => f.id === filter) ?? FILTERS[3])!.test), [rows, filter]);

  const columns = useMemo<ColDef<QueueRow>[]>(
    () => [
      { headerName: "Report", field: "title", flex: 2.2, minWidth: 240, cellRenderer: ReportCell, getQuickFilterText: (p) => `${p.data?.title} ${p.data?.id}` },
      { headerName: "Researcher", field: "handle", flex: 1, minWidth: 120, cellRenderer: (p: ICellRendererParams<QueueRow>) => cell(<span className="truncate">@{p.value}</span>) },
      {
        headerName: "Verdict",
        field: "verdict",
        flex: 1,
        minWidth: 136,
        cellRenderer: (p: ICellRendererParams<QueueRow>) =>
          cell(
            <span className="inline-flex items-center gap-1.5">
              <VerdictBadge verdict={p.data?.verdict} pending={p.data?.status === "queued" || p.data?.status === "triaging"} />
              {p.data?.aiUnavailable && (
                <span title="The AI was unavailable: automatic checks only" className="inline-flex items-center text-warning-strong">
                  <TriangleAlertIcon className="size-3.5" aria-hidden />
                  <span className="sr-only">AI unavailable</span>
                </span>
              )}
            </span>,
          ),
      },
      {
        headerName: "Severity",
        field: "severity",
        flex: 0.8,
        minWidth: 100,
        comparator: (a?: string, b?: string) => rank(a) - rank(b),
        cellRenderer: (p: ICellRendererParams<QueueRow>) => cell(<SeverityLabel level={p.data?.severity ?? p.data?.claimedSeverity} muted={!p.data?.severity} />),
      },
      {
        headerName: "Age",
        field: "submittedAt",
        flex: 0.8,
        minWidth: 96,
        sort: "desc",
        cellRenderer: (p: ICellRendererParams<QueueRow>) => cell(<span className="text-muted-foreground tabular">{timeAgo(p.value)}</span>),
      },
      {
        headerName: "Deposit",
        field: "depositStatus",
        flex: 1.2,
        minWidth: 160,
        cellRenderer: (p: ICellRendererParams<QueueRow>) =>
          cell(
            p.data?.kind === "free" ? (
              <span className="text-xs text-muted-foreground">Free report</span>
            ) : (
              <span className="flex items-center gap-2">
                <DepositBadge status={p.data?.depositStatus} />
                {p.data?.depositAmount && <Money value={p.data.depositAmount} className="text-xs text-muted-foreground" />}
              </span>
            ),
          ),
      },
      {
        headerName: "Payout",
        field: "payoutStatus",
        flex: 1.2,
        minWidth: 150,
        cellRenderer: (p: ICellRendererParams<QueueRow>) =>
          cell(
            p.data?.payoutStatus ? (
              <span className="flex items-center gap-2">
                <PayoutBadge status={p.data.payoutStatus} />
                {p.data.payoutAmount && <Money value={p.data.payoutAmount} className="text-xs" />}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            ),
          ),
      },
      { headerName: "State", field: "status", flex: 1.2, minWidth: 160, cellRenderer: (p: ICellRendererParams<QueueRow>) => cell(p.data ? <ReportStatusBadge status={p.data.status} /> : null) },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Queue filter" className="inline-flex rounded-lg bg-muted p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn("rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors", filter === f.id && "bg-background font-medium text-foreground shadow-soft")}
            >
              {f.label}
              <span className="ml-1.5 font-mono text-xs tabular opacity-70">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search reports" placeholder="Search title or id" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
      </div>

      <div className="hidden md:block">
        <div style={{ height: Math.min(720, 40 + Math.max(visible.length, 4) * 58) }}>
          <AgGridReact<QueueRow>
            theme={gridTheme}
            rowData={visible}
            columnDefs={columns}
            getRowId={(p) => p.data.id}
            quickFilterText={search}
            defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
            animateRows
            suppressCellFocus
            rowClass="cursor-pointer"
            onRowClicked={(e: RowClickedEvent<QueueRow>) => e.data && router.push(`/console/r/${e.data.id}`)}
            overlayNoRowsTemplate={`<span class="text-sm">Nothing here yet. Submit a report or run the judge demo.</span>`}
          />
        </div>
      </div>

      <ul className="space-y-2 md:hidden">
        {visible
          .filter((r) => !search || `${r.title} ${r.id}`.toLowerCase().includes(search.toLowerCase()))
          .map((r) => (
            <li key={r.id}>
              <Link href={`/console/r/${r.id}`} className="block space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
                <p className="font-medium leading-snug">{r.title}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <VerdictBadge verdict={r.verdict} pending={r.status === "queued" || r.status === "triaging"} />
                  {r.kind === "bounty" && <DepositBadge status={r.depositStatus} />}
                  {r.payoutStatus && <PayoutBadge status={r.payoutStatus} />}
                </div>
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>@{r.handle}</span>
                  <span>{now === undefined ? formatDateTime(r.submittedAt) : timeAgo(r.submittedAt, now)}</span>
                  <span className="font-mono">{r.id}</span>
                </p>
              </Link>
            </li>
          ))}
        {visible.length === 0 && <li className="rounded-xl bg-muted/50 p-6 text-center text-sm text-muted-foreground">Nothing here yet.</li>}
      </ul>
    </div>
  );
}

const ORDER = ["low", "medium", "high", "critical"];
const rank = (s?: string) => (s ? ORDER.indexOf(s) : -1);
