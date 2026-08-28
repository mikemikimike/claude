"use client";

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api-client";

export type MLSListing = {
  mlsId: string;
  listPrice: number;
  address: {
    full: string;
    city: string;
    state: string;
    postalCode: string;
  };
  property: {
    bedrooms: number;
    bathsFull: number;
    area: number;
    subType: string;
  };
  photos: string[];
  mls: {
    status: string;
    daysOnMarket: number;
  };
  /** Only present on CLOSED listings — drives comparable-sales analysis (#374). */
  sales?: {
    closePrice: number;
    closeDate: string;
  };
  remarks: string;
};

export type MLSSearchParams = {
  minPrice?: number;
  maxPrice?: number;
  cities?: string[];
  minBeds?: number;
};

export function useMLSConnection() {
  const queryClient = useQueryClient();
  const queryKey = ['me-mls'];

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const r = await api.get<{ connected: boolean }>('/me/mls');
        return { connected: r.connected, known: true };
      } catch {
        // The read failed — we do NOT know the agent's state. `connected:false`
        // keeps the Settings form's long-standing shape, but `known:false` is
        // what stops anything ASSERTING they aren't connected off the back of an
        // outage (#428, same family as #309).
        return { connected: false, known: false };
      }
    },
  });

  async function saveMLS(key: string, secret: string): Promise<void> {
    const r = await api.patch<{ ok: boolean; connected: boolean }>('/me/mls', { key, secret });
    queryClient.setQueryData(queryKey, { connected: r.connected, known: true });
  }

  async function disconnectMLS(): Promise<void> {
    await api.patch('/me/mls', { key: '', secret: '' });
    queryClient.setQueryData(queryKey, { connected: false, known: true });
  }

  return {
    connected: query.data?.connected ?? false,
    /** False while loading AND whenever the status read failed (#428). */
    known: query.data?.known ?? false,
    loading: query.isLoading,
    saveMLS,
    disconnectMLS,
  };
}

/**
 * Why a listing search failed (#428). The one distinction that must never
 * collapse — it is the bug closed #309 fixed, one layer down:
 *
 *  - `not_connected` — the agent has no MLS credentials on file. The search
 *    route answers 503 for exactly this and nothing else. Waiting on a person.
 *  - `unavailable`   — the credentials are fine, SimplyRETS isn't. The route
 *    answers 502 for any provider failure (5xx / timeout / network); a request
 *    that never got a response at all lands here too. Waiting on a service.
 *
 * Telling a buyer their agent "hasn't connected their MLS" during a SimplyRETS
 * outage sends them chasing a problem that does not exist.
 */
export type MLSErrorKind = 'none' | 'not_connected' | 'unavailable' | 'other';

function classifyMLSError(e: unknown): MLSErrorKind {
  if (!e) return 'none';
  if (e instanceof ApiError) {
    if (e.status === 503) return 'not_connected';
    if (e.status === 502 || e.status === 504) return 'unavailable';
    return 'other';
  }
  // No HTTP response at all — a dropped connection or the client's own 15s
  // AbortSignal timeout. That is the service being unreachable, not the agent
  // having done something wrong.
  return 'unavailable';
}

export function useMLSListings(dealId: string | null) {
  const mutation = useMutation({
    mutationFn: async (params: MLSSearchParams) => {
      if (!dealId) return [] as MLSListing[];
      const qs = new URLSearchParams();
      if (params.minPrice) qs.set('minprice', String(params.minPrice));
      if (params.maxPrice) qs.set('maxprice', String(params.maxPrice));
      if (params.cities?.length) params.cities.forEach((c) => qs.append('cities', c));
      if (params.minBeds) qs.set('minbeds', String(params.minBeds));
      return api.get<MLSListing[]>(`/deals/${dealId}/listings/search?${qs}`);
    },
  });

  const search = useCallback(
    (params: MLSSearchParams) => {
      if (!dealId) return;
      mutation.mutate(params);
    },
    [dealId, mutation],
  );

  return {
    listings: mutation.data ?? [],
    loading: mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : '',
    /**
     * The cause, classified from the HTTP status (#428). The raw `error` above
     * is an `ApiError` message like "503 — Service Unavailable — agent has not
     * connected MLS", so string-matching it against the bare server text never
     * matched — which is why the buyer used to see that raw line.
     */
    errorKind: classifyMLSError(mutation.error),
    search,
  };
}
