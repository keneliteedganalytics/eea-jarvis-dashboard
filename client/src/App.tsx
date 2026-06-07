import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { JarvisProvider } from "@/lib/jarvis";
import { JarvisPlayer } from "@/components/JarvisPlayer";
import { AppLayout } from "@/components/AppLayout";
import { useLiveEvents } from "@/lib/useLiveEvents";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Review from "@/pages/Review";
import RaceDetail from "@/pages/RaceDetail";
import Results from "@/pages/Results";
import Analytics from "@/pages/Analytics";
import Settings from "@/pages/Settings";
import Print from "@/pages/Print";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/review/:id" component={Review} />
      <Route path="/race/:n" component={RaceDetail} />
      <Route path="/results" component={Results} />
      <Route path="/analytics" component={Analytics} />
      <Route path="/settings" component={Settings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function Shell() {
  useLiveEvents();
  return (
    <Switch>
      {/* Standalone printable page — no app chrome, no Jarvis player. */}
      <Route path="/print" component={Print} />
      <Route>
        <AppLayout>
          <AppRouter />
          <JarvisPlayer />
        </AppLayout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <JarvisProvider>
          <Router hook={useHashLocation}>
            <Shell />
          </Router>
        </JarvisProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
