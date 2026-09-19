import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { useOptionalCompany } from "./CompanyContext";
import { useSharedPollingQuery, usePublishSharedQueryData } from "../hooks/useSharedPolling";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";

/**
 * Which issues currently have an agent working on them (PAP-640).
 *
 * Task *status* and agent *activity* are different things: a task can sit in
 * `in_progress` for hours between runs with nobody executing. This provider
 * owns the one company-wide live-run read (same query key, shared-polling
 * resource and event-sourced cache as the sidebar, so the two dedupe) and
 * exposes just the issue ids with a queued/running run — the same "live"
 * definition the Live pill and `liveIssueIds` use elsewhere.
 *
 * Consumers read it through {@link useIsAgentWorkingOnIssue}; the status glyph
 * uses it to animate the in-progress icon only while work is actually moving.
 */
const AgentActivityContext = createContext<ReadonlySet<string> | null>(null);

const EMPTY_ACTIVE_IDS: ReadonlySet<string> = new Set<string>();

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const company = useOptionalCompany();
  const companyId = company?.selectedCompanyId ?? null;
  const liveRunsQueryKey = queryKeys.liveRuns(companyId ?? "__no-company__");
  const sharedLiveRuns = useSharedPollingQuery<LiveRunForIssue[]>({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider, like every other live-runs reader.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  // Run progress events rewrite the live-runs array constantly (byte counts,
  // status messages) while the *set of working issues* barely changes. Keep the
  // previous Set whenever its members are unchanged so a progress tick doesn't
  // re-render every status icon in the app.
  const activeIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);
  const stableIssueIds = useRef(activeIssueIds);
  if (!sameMembers(stableIssueIds.current, activeIssueIds)) stableIssueIds.current = activeIssueIds;

  return (
    <AgentActivityContext.Provider value={stableIssueIds.current}>{children}</AgentActivityContext.Provider>
  );
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * True when an agent is actively working (queued or running run) on this issue.
 * Returns false without an id and outside the provider, so provider-less
 * surfaces and unit tests degrade to the calm, non-animated rendering.
 */
export function useIsAgentWorkingOnIssue(issueId: string | null | undefined): boolean {
  const activeIssueIds = useContext(AgentActivityContext) ?? EMPTY_ACTIVE_IDS;
  return !!issueId && activeIssueIds.has(issueId);
}

/** Test/story seam: provide a fixed working-issue set without any data fetching. */
export function AgentActivityTestProvider({
  activeIssueIds,
  children,
}: {
  activeIssueIds: ReadonlySet<string>;
  children: ReactNode;
}) {
  return <AgentActivityContext.Provider value={activeIssueIds}>{children}</AgentActivityContext.Provider>;
}
