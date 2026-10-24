import type { HttpPoc } from "@goodfaith/core";
import { EyeOffIcon } from "lucide-react";
import { Fragment } from "react";
import { cn } from "@/lib/utils";

/** Inline `code` spans; everything else is plain text. The report is untrusted: nothing here renders HTML. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.8em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * The researcher's markdown, shown as quarantined text: section headings get structure, inline code gets
 * monospace, and HTML comments (invisible in rendered markdown, read by AI triagers) are shown and flagged.
 */
export function ReportBody({ body, className }: { body: string; className?: string }) {
  const segments = body.split(/(<!--[\s\S]*?-->)/g);
  return (
    <div className={cn("space-y-1 text-sm leading-relaxed", className)}>
      {segments.map((seg, i) => {
        if (seg.startsWith("<!--")) {
          return (
            <div key={i} className="my-2 rounded-lg ring-1 ring-danger/40">
              <p className="flex items-center gap-1.5 rounded-t-lg bg-danger-soft px-2.5 py-1 text-[0.7rem] font-semibold tracking-wider text-danger-strong uppercase">
                <EyeOffIcon className="size-3.5" aria-hidden />
                Hidden HTML comment: invisible to humans, read by AI
              </p>
              <p className="px-2.5 py-2 font-mono text-[0.75rem] whitespace-pre-wrap text-danger-strong">{seg}</p>
            </div>
          );
        }
        return seg.split("\n").map((line, j) => {
          const key = `${i}-${j}`;
          const heading = /^#{1,3}\s+(.*)$/.exec(line);
          if (heading) return <h4 key={key} className="pt-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase first:pt-0">{heading[1]}</h4>;
          if (!line.trim()) return <div key={key} className="h-1" />;
          const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
          if (bullet)
            return (
              <p key={key} className="flex gap-2 pl-1">
                <span aria-hidden className="text-muted-foreground">•</span>
                <span className="min-w-0 break-words">
                  <Inline text={bullet[1] ?? ""} />
                </span>
              </p>
            );
          return (
            <p key={key} className="break-words">
              <Inline text={line} />
            </p>
          );
        });
      })}
    </div>
  );
}

export function PocTable({ poc }: { poc: HttpPoc }) {
  return (
    <ol className="space-y-1.5">
      {poc.steps.map((s, i) => (
        <li key={i} className="rounded-lg bg-muted/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[0.78rem]">
            <span className="text-muted-foreground tabular">{i + 1}.</span>
            <span className="font-semibold">{s.method}</span>
            <span className="min-w-0 break-all">{s.path}</span>
            <span className="ml-auto font-sans text-xs text-muted-foreground">
              as <span className="font-mono text-foreground">{s.as ?? "anonymous"}</span>
            </span>
          </div>
          {s.body && <pre className="mt-1.5 overflow-x-auto font-mono text-[0.72rem] text-muted-foreground">{s.body}</pre>}
        </li>
      ))}
    </ol>
  );
}
