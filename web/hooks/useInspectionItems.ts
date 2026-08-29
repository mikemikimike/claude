"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  InspectionItemOwner,
  InspectionItemSeverity,
  InspectionItemStatus,
} from "@/lib/inspection-items";

/** Wire shape of GET/POST/PATCH /api/deals/:id/inspection-items. */
export type InspectionItem = {
  id: string;
  deal_id: string;
  document_id: string | null;
  sort_order: number;
  category: string;
  description: string;
  severity: InspectionItemSeverity;
  status: InspectionItemStatus;
  owner: InspectionItemOwner;
  notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InspectionItemInput = {
  description: string;
  category?: string;
  severity?: InspectionItemSeverity;
  owner?: InspectionItemOwner;
  notes?: string | null;
  document_id?: string | null;
};

export type InspectionItemPatch = Partial<InspectionItemInput> & {
  status?: InspectionItemStatus;
};

/**
 * `enabled` (#429 slice c) lets a caller mount the hook unconditionally — React
 * forbids a conditional hook — while still not issuing the request. The buyer
 * portal's Fast Pass tracker needs the items only for buyers who bought the
 * `inspection_followup` add-on; everyone else should cost zero round trips.
 */
export function useInspectionItems(
  dealId: string,
  options: { enabled?: boolean } = {}
): {
  items: InspectionItem[];
  loading: boolean;
  error: unknown;
  refresh: () => void;
  addItem: (input: InspectionItemInput) => Promise<InspectionItem>;
  updateItem: (id: string, patch: InspectionItemPatch) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const queryKey = ["inspection-items", dealId];

  const query = useQuery({
    queryKey,
    queryFn: () =>
      api.get<InspectionItem[]>(`/deals/${dealId}/inspection-items`),
    enabled: Boolean(dealId) && (options.enabled ?? true),
  });

  async function addItem(input: InspectionItemInput): Promise<InspectionItem> {
    const item = await api.post<InspectionItem>(
      `/deals/${dealId}/inspection-items`,
      input
    );
    queryClient.setQueryData<InspectionItem[]>(queryKey, (prev) => [
      ...(prev ?? []),
      item,
    ]);
    return item;
  }

  async function updateItem(
    id: string,
    patch: InspectionItemPatch
  ): Promise<void> {
    // The server derives resolved_at from status, so the row it returns is the
    // one written into the cache — no local guess at the timestamp.
    const item = await api.patch<InspectionItem>(
      `/deals/${dealId}/inspection-items/${id}`,
      patch
    );
    queryClient.setQueryData<InspectionItem[]>(queryKey, (prev) =>
      (prev ?? []).map((i) => (i.id === id ? item : i))
    );
  }

  async function deleteItem(id: string): Promise<void> {
    await api.delete<{ status: string }>(
      `/deals/${dealId}/inspection-items/${id}`
    );
    queryClient.setQueryData<InspectionItem[]>(queryKey, (prev) =>
      (prev ?? []).filter((i) => i.id !== id)
    );
  }

  return {
    items: query.data ?? [],
    loading: query.isLoading,
    error: query.error,
    refresh: () => {
      void query.refetch();
    },
    addItem,
    updateItem,
    deleteItem,
  };
}
