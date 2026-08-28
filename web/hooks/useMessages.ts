"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export type MessageChannel = 'client_thread' | 'internal';

export type Message = {
  id: string;
  dealId: string;
  senderId: string;
  senderName: string;
  senderRole: 'agent' | 'buyer' | 'seller' | 'admin' | 'tc';
  channel: MessageChannel;
  content: string;
  timestamp: string;
  isAiDraft: false;
};

type ApiMessage = {
  id: string;
  deal_id: string;
  sender_id: string;
  sender_name: string;
  sender_role: string;
  channel: string;
  body: string;
  created_at: string;
};

function apiMessageToFrontend(m: ApiMessage): Message {
  return {
    id: m.id,
    dealId: m.deal_id,
    senderId: m.sender_id,
    senderName: m.sender_name,
    senderRole: m.sender_role as Message['senderRole'],
    channel: m.channel as MessageChannel,
    content: m.body,
    timestamp: m.created_at,
    isAiDraft: false,
  };
}

export function useMessages(dealId: string, channel: MessageChannel): {
  messages: Message[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const query = useQuery({
    queryKey: ['messages', dealId, channel],
    queryFn: async () => {
      const data = await api.get<ApiMessage[]>(`/deals/${dealId}/messages?channel=${channel}`);
      return data.map(apiMessageToFrontend);
    },
    enabled: Boolean(dealId),
    refetchInterval: 10_000, // Poll every 10s — replaces manual setInterval
  });

  return {
    messages: query.data ?? [],
    loading: query.isLoading,
    error: query.error instanceof Error ? 'Failed to load messages' : null,
    refresh: () => { void query.refetch(); },
  };
}

export async function postMessage(
  dealId: string,
  channel: MessageChannel,
  body: string,
): Promise<Message> {
  const m = await api.post<ApiMessage>(`/deals/${dealId}/messages`, { channel, body });
  return apiMessageToFrontend(m);
}

// ─── Unread counts (#424) ─────────────────────────────────────────────────────

type ApiUnreadCounts = { total: number; by_deal: Record<string, number> };

export type UnreadMessageCounts = { total: number; byDeal: Record<string, number> };

const UNREAD_QUERY_KEY = ['messages', 'unread-count'];

const EMPTY_UNREAD: UnreadMessageCounts = { total: 0, byDeal: {} };

/**
 * Unread client-thread messages for the signed-in user, total and per deal.
 * Scoped server-side (see lib/messages.ts) — this is display only.
 */
export function useUnreadMessageCounts(): UnreadMessageCounts {
  const query = useQuery({
    queryKey: UNREAD_QUERY_KEY,
    queryFn: async () => {
      const data = await api.get<ApiUnreadCounts>('/messages/unread-count');
      return { total: data.total ?? 0, byDeal: data.by_deal ?? {} };
    },
    // Matches the notification bell's cadence; the per-thread poll in
    // useMessages stays at 10s for an open conversation.
    refetchInterval: 30_000,
  });

  return query.data ?? EMPTY_UNREAD;
}

/** Convenience for the nav badge, which only needs the total. */
export function useUnreadMessageCount(): number {
  return useUnreadMessageCounts().total;
}

/**
 * Marks one thread read and refreshes the badge. Best-effort: a failure leaves
 * the badge up rather than lying about it, and the next poll retries nothing —
 * the user re-opening the thread fires this again.
 */
export function useMarkThreadRead(): (dealId: string, channel: MessageChannel) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (dealId: string, channel: MessageChannel) => {
      void (async () => {
        try {
          await api.post(`/deals/${dealId}/messages/read`, { channel });
          await queryClient.invalidateQueries({ queryKey: UNREAD_QUERY_KEY });
        } catch {
          // Non-fatal — the badge just stays until the next successful read.
        }
      })();
    },
    [queryClient],
  );
}
