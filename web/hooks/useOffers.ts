"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type Offer = {
  id: string;
  dealId: string;
  /** The tracked property the offer is on (#410); null on legacy/seller offers. */
  trackedPropertyId?: string;
  buyerName: string;
  offerPrice: number;
  closeDate?: string;
  contingencies: string[];
  agentNotes: string;
  submittedAt: string;
};

type ApiOffer = {
  id: string;
  deal_id: string;
  tracked_property_id?: string | null;
  buyer_name: string;
  offer_price: number;
  close_date?: string | null;
  contingencies: string[];
  agent_notes: string;
  submitted_at: string;
};

function fromApi(o: ApiOffer): Offer {
  return {
    id: o.id,
    dealId: o.deal_id,
    trackedPropertyId: o.tracked_property_id ?? undefined,
    buyerName: o.buyer_name,
    offerPrice: o.offer_price,
    closeDate: o.close_date ?? undefined,
    contingencies: o.contingencies ?? [],
    agentNotes: o.agent_notes,
    submittedAt: o.submitted_at,
  };
}

export function useOffers(dealId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['offers', dealId ?? ''];

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const raw = await api.get<ApiOffer[]>(`/deals/${dealId}/offers`);
      return raw.map(fromApi);
    },
    enabled: Boolean(dealId),
  });

  async function addOffer(o: Omit<Offer, 'id' | 'dealId' | 'submittedAt'>) {
    if (!dealId) return;
    const raw = await api.post<ApiOffer>(`/deals/${dealId}/offers`, {
      tracked_property_id: o.trackedPropertyId ?? null,
      buyer_name: o.buyerName,
      offer_price: o.offerPrice,
      close_date: o.closeDate || null,
      contingencies: o.contingencies,
      agent_notes: o.agentNotes,
    });
    queryClient.setQueryData<Offer[]>(queryKey, (prev) => [fromApi(raw), ...(prev ?? [])]);
  }

  async function removeOffer(offerId: string) {
    await api.delete(`/offers/${offerId}`);
    queryClient.setQueryData<Offer[]>(queryKey, (prev) =>
      (prev ?? []).filter((o) => o.id !== offerId),
    );
  }

  return {
    offers: query.data ?? [],
    loading: query.isLoading,
    refresh: () => { void query.refetch(); },
    addOffer,
    removeOffer,
  };
}
