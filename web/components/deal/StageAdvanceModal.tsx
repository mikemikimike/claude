"use client";

import { useState } from "react";
import { Deal, DealStage } from "@/lib/types";
import { stageAutoTasks } from "@/lib/stage-auto-tasks";
import { CheckCircle2, Circle, Zap, Pencil, AlertTriangle } from "lucide-react";
import { STAGE_LABELS, STAGE_DRAFT_MESSAGE } from "@/components/deal/shared";

/**
 * One row of the 422 gate payload. `source`/`stage_context` are optional so an
 * older cached client bundle (or any caller that only has id+title) still
 * renders — it just doesn't get the auto-generated wording.
 */
export type BlockingTask = {
  id: string;
  title: string;
  source?: string | null;
  stage_context?: string | null;
};

export function StageAdvanceModal({ deal, nextStage, gateError, onConfirm, onCancel }: {
  deal: Deal;
  nextStage: DealStage;
  gateError?: { blockingTasks: BlockingTask[] } | null;
  onConfirm: (draftMessage: string, force?: boolean) => void;
  onCancel: () => void;
}) {
  const autoTasks = stageAutoTasks(nextStage, deal);
  const defaultMsg = STAGE_DRAFT_MESSAGE[nextStage]?.(deal) ?? '';
  const [msg, setMsg] = useState(defaultMsg);
  const [editingMsg, setEditingMsg] = useState(false);

  // Only list automations that actually run on confirm (#185): auto tasks are
  // created via POST /tasks, the (edited) client message is posted to the
  // client thread, and the stage PATCH enqueues the calendar closing-event
  // push. The old "TC alerted to open file" / "Commission paperwork queued"
  // claims had no implementation behind them and were removed.
  const automationItems = [
    autoTasks.length > 0 ? `${autoTasks.length} task${autoTasks.length !== 1 ? 's' : ''} auto-generated` : null,
    msg.trim() ? `Client message sent to ${deal.clientName}` : null,
    nextStage === 'pre_close' || nextStage === 'closing' ? 'Closing date synced to calendar' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-4 pb-0">
      <div className="w-full max-w-lg rounded-t-2xl bg-white shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Stage Advance</p>
          <h3 className="text-base font-black text-brand-navy mt-0.5">
            Moving to: <span className="text-brand-navy">{STAGE_LABELS[nextStage]}</span>
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">{deal.clientName} · {deal.property.address}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Automation summary */}
          {automationItems.length > 0 && (
            <div className="rounded-xl bg-brand-navy/5 border border-brand-navy/10 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={14} className="text-brand-navy" />
                <p className="text-xs font-bold uppercase tracking-widest text-brand-navy">Will run automatically</p>
              </div>
              <div className="space-y-2">
                {automationItems.map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
                    <span className="text-sm text-gray-700">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Auto-generated tasks preview */}
          {autoTasks.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">Tasks to be created</p>
              <div className="space-y-1.5">
                {autoTasks.map((task, i) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5">
                    <Circle size={12} className="text-gray-300 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-brand-navy leading-snug">{task.title}</p>
                      {task.description && (
                        <p className="text-[10px] text-gray-400 mt-0.5">{task.description}</p>
                      )}
                    </div>
                    <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      task.assignedTo === 'tc' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {task.assignedTo === 'tc' ? 'TC' : 'Agent'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Client message draft */}
          {defaultMsg && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Client message</p>
                <button
                  onClick={() => setEditingMsg((p) => !p)}
                  className="flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-brand-navy/70 transition-colors"
                >
                  <Pencil size={11} /> {editingMsg ? 'Done' : 'Edit'}
                </button>
              </div>
              {editingMsg ? (
                <textarea
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  rows={5}
                  aria-label="Client message"
                  className="w-full rounded-xl border border-brand-navy/20 bg-white px-3 py-2.5 text-sm text-gray-700 outline-none focus:border-brand-navy/40 resize-none leading-relaxed"
                />
              ) : (
                <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3">
                  <p className="text-sm text-gray-700 leading-relaxed">{msg}</p>
                </div>
              )}
              <p className="mt-1.5 text-[10px] text-gray-400">
                {msg.trim()
                  ? <>Sent to the client&apos;s message thread when you confirm.</>
                  : <>Empty message — nothing will be sent to the client.</>}
              </p>
            </div>
          )}
        </div>

        {/* Gate error — blocking tasks */}
        {gateError && (() => {
          // Own up to the app's own tasks (#419). The gate fires on the
          // high-priority tasks *the system* seeded when the deal entered this
          // stage, so "N required tasks still open" read as the agent's own
          // backlog for work they never created. Name them, and name the stage
          // that generated them (falling back to the deal's current stage for a
          // row with no stage_context).
          const tasks = gateError.blockingTasks;
          const auto = tasks.filter((t) => t.source === 'ai');
          const autoStages = [...new Set(
            auto.map((t) => STAGE_LABELS[(t.stage_context ?? deal.stage) as DealStage])
              .filter(Boolean)
          )];
          return (
            <div className="mx-5 mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                <p className="text-xs font-bold text-amber-700">
                  {tasks.length} required task{tasks.length !== 1 ? 's' : ''} still open
                </p>
              </div>
              <div className="space-y-1 mb-3">
                {tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <Circle size={10} className="text-amber-400 flex-shrink-0" />
                    <span className="text-xs text-amber-800">{t.title}</span>
                    {t.source === 'ai' && (
                      <span className="flex-shrink-0 rounded-full bg-amber-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-800">
                        Auto
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {auto.length > 0 && autoStages.length > 0 && (
                <p className="mb-1.5 text-[10px] text-amber-700">
                  {auto.length === tasks.length
                    ? auto.length === 1 ? 'This one was' : 'These were'
                    : `${auto.length} of these ${auto.length === 1 ? 'was' : 'were'}`}
                  {' '}generated automatically when the deal entered {autoStages.join(' / ')}.
                </p>
              )}
              <p className="text-[10px] text-amber-600">Complete these tasks or use &quot;Force Advance&quot; to override.</p>
            </div>
          );
        })()}

        {/* Footer */}
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          {gateError ? (
            <button
              onClick={() => onConfirm(msg, true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3.5 text-sm font-bold text-white hover:bg-amber-600 transition-colors"
            >
              <Zap size={14} /> Force Advance Anyway
            </button>
          ) : (
            <button
              onClick={() => onConfirm(msg)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-3.5 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
            >
              <Zap size={14} /> Confirm & Advance
            </button>
          )}
          <button
            onClick={onCancel}
            className="w-full text-center text-sm text-gray-400 hover:text-gray-600 py-1.5 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Stage Transition Bar ────────────────────────────────────────────────────
