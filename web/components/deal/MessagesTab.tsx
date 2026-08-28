"use client";

import { useEffect, useState } from "react";
import { Deal } from "@/lib/types";
import { useAuthStore } from "@/lib/store/authStore";
import { usePermission } from "@/permissions/usePermission";
import { PERMISSIONS } from "@/permissions/permissions";
import {
  useMessages,
  postMessage,
  useMarkThreadRead,
  MessageChannel,
} from "@/hooks/useMessages";
import { Loader2, MessageSquare, Bot, ChevronRight, Users, AlertTriangle } from "lucide-react";
import { formatTimestamp } from "@/components/deal/shared";

const AVATAR_COLOR: Record<string, string> = {
  agent:  'bg-brand-navy',
  buyer:  'bg-green-500',
  seller: 'bg-purple-500',
  tc:     'bg-amber-500',
  admin:  'bg-red-500',
};

export function MessagesTab({ deal }: { deal: Deal }) {
  const { can } = usePermission();
  const canSeeInternal = can(PERMISSIONS.MESSAGE_VIEW) && can(PERMISSIONS.MESSAGE_PIN);
  const [channel, setChannel] = useState<MessageChannel>('client_thread');
  const { messages, loading, refresh } = useMessages(deal.id, channel);
  const activeUser = useAuthStore((s) => s.activeUser);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // #424 — viewing a thread IS reading it. Re-runs when the thread grows, so a
  // message that lands while the tab is open doesn't leave a stale badge. Keyed
  // on the count rather than the array so the 10s poll doesn't re-post on every
  // identical refetch. No-ops until the first load resolves.
  const markThreadRead = useMarkThreadRead();
  const messageCount = messages.length;
  useEffect(() => {
    if (loading || messageCount === 0) return;
    markThreadRead(deal.id, channel);
  }, [deal.id, channel, messageCount, loading, markThreadRead]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await postMessage(deal.id, channel, body);
      setDraft('');
      await refresh();
    } catch {
      // leave draft intact so the user can retry
    } finally {
      setSending(false);
    }
  }

  // Inlined Thread content (was previously a nested function component that
  // violated react-hooks/static-components — closed over loading/messages/
  // activeUser/channel)
  const threadContent = (loading && messages.length === 0) ? (
    <div className="flex items-center justify-center py-10">
      <Loader2 size={16} className="animate-spin text-gray-300" />
    </div>
  ) : (
    <div className="p-4 space-y-4">
      {messages.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-400">No messages yet.</p>
      )}
      {messages.map((msg) => {
        const isMe = msg.senderId === activeUser?.id;
        const avatarColor = AVATAR_COLOR[msg.senderRole] ?? 'bg-gray-400';
        return (
          <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : 'flex-row'}`}>
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white text-xs font-bold ${avatarColor}`}>
              {msg.senderName.charAt(0)}
            </div>
            <div className={`flex-1 max-w-[80%] ${isMe ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
              <div className={`flex items-center gap-2 text-xs text-gray-400 ${isMe ? 'flex-row-reverse' : ''}`}>
                <span className="font-medium text-gray-600">{msg.senderName}</span>
                {msg.senderRole === 'tc' && (
                  <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">TC</span>
                )}
                {msg.isAiDraft && (
                  <span className="flex items-center gap-0.5 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600">
                    <Bot size={9} /> AI draft
                  </span>
                )}
                <span>{formatTimestamp(msg.timestamp)}</span>
              </div>
              <div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                isMe
                  ? 'bg-brand-navy text-white rounded-tr-sm'
                  : channel === 'internal'
                  ? 'bg-amber-50 text-gray-800 rounded-tl-sm border border-amber-100'
                  : 'bg-gray-100 text-gray-800 rounded-tl-sm'
              }`}>
                {msg.content}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Channel switcher */}
      <div className="flex border-b border-gray-100">
        <button
          onClick={() => setChannel('client_thread')}
          className={[
            'flex-1 py-3 text-xs font-bold transition-colors',
            channel === 'client_thread'
              ? 'text-brand-navy border-b-2 border-brand-navy bg-white'
              : 'text-gray-400 hover:text-gray-600',
          ].join(' ')}
        >
          <div className="flex items-center justify-center gap-1.5">
            <Users size={12} />
            Client Thread
          </div>
          <div className="text-[10px] font-normal mt-0.5 opacity-70">Agent · Client · TC</div>
        </button>

        {canSeeInternal && (
          <button
            onClick={() => setChannel('internal')}
            className={[
              'flex-1 py-3 text-xs font-bold transition-colors',
              channel === 'internal'
                ? 'text-amber-700 border-b-2 border-amber-500 bg-white'
                : 'text-gray-400 hover:text-gray-600',
            ].join(' ')}
          >
            <div className="flex items-center justify-center gap-1.5">
              <MessageSquare size={12} />
              Internal
            </div>
            <div className="text-[10px] font-normal mt-0.5 opacity-70">Agent + TC only</div>
          </button>
        )}
      </div>

      {channel === 'internal' && (
        <div className="flex items-center gap-2 bg-amber-50 border-b border-amber-100 px-4 py-2">
          <AlertTriangle size={12} className="text-amber-600 flex-shrink-0" />
          <p className="text-[11px] text-amber-700 font-medium">Not visible to clients</p>
        </div>
      )}

      {threadContent}

      {/* Compose area */}
      <div className="border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={channel === 'internal' ? 'Message your TC...' : 'Message the client...'}
            className="flex-1 rounded-full border border-gray-200 bg-brand-bg px-4 py-2 text-sm outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10 disabled:opacity-50"
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || sending}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-white hover:bg-brand-navy/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <ChevronRight size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
