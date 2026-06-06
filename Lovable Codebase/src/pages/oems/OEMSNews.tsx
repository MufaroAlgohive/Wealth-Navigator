import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, Newspaper } from "lucide-react";
import { cn } from "@/lib/utils";
import { newsFeed } from "@/lib/oemsData";

const cats = ["all", "company", "macro", "rates", "fx", "commodity", "politics"] as const;

export default function OEMSNews() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<(typeof cats)[number]>("all");
  const filtered = newsFeed.filter(n =>
    (cat === "all" || n.category === cat) &&
    (q === "" || n.headline.toLowerCase().includes(q.toLowerCase()) || n.tickers.some(t => t.toLowerCase().includes(q.toLowerCase())))
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2"><Newspaper className="h-4 w-4 text-primary" />News Flow</CardTitle>
            <p className="text-xs text-muted-foreground">IRIS WebSocket /stream/news · Reuters, SENS, Bloomberg, Dow Jones, Moneyweb, Business Day</p>
          </div>
          <Badge className="bg-success/10 text-success border-success/30 font-mono text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-success mr-1.5 inline-block animate-pulse" />LIVE</Badge>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search headlines or tickers (e.g. NPN, USD/ZAR)" className="pl-9 h-9" />
            </div>
            <div className="flex gap-1">
              {cats.map(c => (
                <button key={c} onClick={() => setCat(c)} className={cn("px-3 py-1.5 text-[11px] rounded-md font-medium capitalize", cat === c ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-border border border-border rounded-md max-h-[640px] overflow-y-auto">
            {filtered.map(n => (
              <div key={n.id} className="p-4 hover:bg-secondary/30">
                <div className="flex items-start gap-3">
                  {n.priority === "high" && <span className="h-2 w-2 rounded-full bg-destructive mt-1.5 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-snug">{n.headline}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] font-mono text-muted-foreground">
                      <span>{n.time} SAST</span>
                      <span>·</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5">{n.source}</Badge>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 capitalize">{n.category}</Badge>
                      {n.tickers.length > 0 && (
                        <span className="text-primary">{n.tickers.map(t => <span key={t} className="mr-1.5">{t}</span>)}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
