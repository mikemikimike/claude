"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type TCInfo = {
  name: string;
  email: string;
  phone: string;
  userId: string | null;
  /**
   * Only meaningful on the result of saveTC: true when that save actually
   * emailed the TC an invite (no account yet + the send succeeded). GET never
   * sets it, so it is undefined for the cached record.
   */
  invited?: boolean;
};

type ApiTCInfo = {
  name: string;
  email: string;
  phone: string;
  user_id: string | null;
  invited?: boolean;
};

function fromApi(t: ApiTCInfo): TCInfo {
  return {
    name: t.name,
    email: t.email,
    phone: t.phone,
    userId: t.user_id,
    invited: t.invited,
  };
}

export function useTC() {
  const queryClient = useQueryClient();
  const queryKey = ['me-tc'];

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const raw = await api.get<ApiTCInfo>('/me/tc');
        return fromApi(raw);
      } catch {
        return null;
      }
    },
  });

  async function saveTC(name: string, email: string, phone: string): Promise<TCInfo> {
    const raw = await api.put<ApiTCInfo>('/me/tc', { name, email, phone });
    const info = fromApi(raw);
    queryClient.setQueryData(queryKey, info);
    return info;
  }

  async function removeTC(): Promise<void> {
    await api.delete('/me/tc');
    queryClient.setQueryData(queryKey, null);
  }

  return {
    tc: query.data ?? null,
    loading: query.isLoading,
    refresh: () => { void query.refetch(); },
    saveTC,
    removeTC,
  };
}

export type AgentSummary = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  activeDealCount: number;
};

type ApiAgentSummary = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active_deal_count: number;
};

export function useMyAgents() {
  const query = useQuery({
    queryKey: ['me-agents'],
    queryFn: async () => {
      try {
        const rows = await api.get<ApiAgentSummary[]>('/me/agents');
        return rows.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          phone: a.phone,
          activeDealCount: a.active_deal_count,
        }));
      } catch {
        return [] as AgentSummary[];
      }
    },
  });

  return { agents: query.data ?? [], loading: query.isLoading };
}
