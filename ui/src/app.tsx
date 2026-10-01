import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api';
import { RunDetailView } from '@/components/run-detail';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePoll } from '@/hooks/use-poll';
import { HistoryPage } from '@/pages/history';
import { LivePage } from '@/pages/live';
import { StatsPage } from '@/pages/stats';
import { cn } from '@/lib/utils';

const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
type Tab = 'live' | 'history' | 'stats';

function Logo() {
  return (
    <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-orange-300 shadow-lg shadow-brand/25">
      <svg viewBox="0 0 24 24" className="size-5 fill-white"><path d="M4 4h4v4H4zm8 0h4v4h-4zM8 8h4v4H8zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4zm-4 4h4v4H8zm8 0h4v4h-4z" /></svg>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => { const d = !dark; document.documentElement.classList.toggle('dark', d); try { localStorage.setItem('pitroom-theme', d ? 'dark' : 'light'); } catch { /* private mode */ } setDark(d); }}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function App() {
  const hash = location.hash.slice(1);
  const [tab, setTab] = useState<Tab>(hash === 'history' || hash === 'stats' ? hash : 'live');
  const [open, setOpen] = useState<string | null>(null);
  const focus = RUN_ID.test(hash) ? hash : undefined;
  const { data, error } = usePoll(() => api.state(1), 4000, []);
  useEffect(() => { document.title = `${data?.running ? `(${data.running}) ` : ''}Pitroom`; }, [data?.running]);
  useEffect(() => { if (focus) setOpen(focus); }, [focus]);

  return (
    <TooltipProvider delay={150}>
      <div className="relative min-h-screen">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(60rem_30rem_at_85%_-10%,color-mix(in_oklab,var(--brand)_14%,transparent),transparent_60%),radial-gradient(50rem_28rem_at_-10%_0%,color-mix(in_oklab,var(--info)_12%,transparent),transparent_60%)]" />
        <main className="mx-auto max-w-4xl px-4 pb-16 pt-8">
          <header className="mb-6 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-700">
            <Logo />
            <div className="leading-tight"><h1 className="text-xl font-semibold tracking-tight">Pitroom</h1><p className="text-[13px] text-muted-foreground">Your agent's pit crew, live</p></div>
            <div className="flex-1" />
            <span className="flex items-center gap-2 text-xs text-muted-foreground"><span className={cn('size-1.5 rounded-full', error ? 'bg-destructive' : 'bg-success animate-pulse')} />{error ? 'offline' : 'live'}</span>
            <ThemeToggle />
          </header>
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList className="mb-5"><TabsTrigger value="live">Live</TabsTrigger><TabsTrigger value="history">History</TabsTrigger><TabsTrigger value="stats">Stats</TabsTrigger></TabsList>
          </Tabs>
          <div key={tab} className="animate-in fade-in slide-in-from-bottom-1 duration-300">
            {tab === 'live' && <LivePage focus={focus} />}
            {tab === 'history' && <HistoryPage onOpen={setOpen} />}
            {tab === 'stats' && <StatsPage />}
          </div>
          <footer className="mt-10 text-center text-xs text-muted-foreground/70">Read-only · this machine only</footer>
        </main>
        <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
            <SheetHeader><SheetTitle>Run</SheetTitle><SheetDescription className="font-mono text-xs">{open}</SheetDescription></SheetHeader>
            <div className="px-4 pb-6">{open && <RunDetailView id={open} />}</div>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}
