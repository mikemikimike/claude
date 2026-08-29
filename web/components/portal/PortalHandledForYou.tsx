'use client';

/**
 * "Being handled for you" — the read-only half of a client portal's task area
 * (#423).
 *
 * A tester looking at the buyer portal asked, of rows that were not his:
 * "I don't know what this is… do I need to be doing these?" The portals'
 * answer at the time was to filter every non-client task out silently, which
 * traded one confusion for another: the client could see a stage was busy but
 * had no idea what was happening in it, and any count that leaked through had
 * nothing behind it.
 *
 * So the work is shown, but never as something to act on. It is collapsed by
 * default, every row names who owns it, and — deliberately — there is not a
 * single button inside: a row the client cannot action must not look like a
 * click target that does nothing.
 */

import { ChevronRight } from 'lucide-react';
import { taskHandlerLabel } from '@/lib/portal-tasks';

export type HandledTask = {
  id: string;
  title: string;
  assignedTo?: string | null;
};

export default function PortalHandledForYou({
  tasks,
  /** "your agent" for the buyer/seller portals; overridable if that ever differs. */
  ownerLabel = 'Your agent',
}: {
  tasks: readonly HandledTask[];
  ownerLabel?: string;
}) {
  if (tasks.length === 0) return null;

  return (
    <details
      data-testid="portal-tasks-handled"
      className="group overflow-hidden rounded-xl border border-gray-100 bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-semibold text-gray-400 hover:bg-black/[0.02]">
        <ChevronRight
          size={13}
          className="flex-shrink-0 text-gray-300 transition-transform duration-150 group-open:rotate-90"
        />
        {ownerLabel} is handling {tasks.length} other step{tasks.length !== 1 ? 's' : ''}
      </summary>
      <div className="space-y-2 border-t border-gray-100 px-4 py-3">
        <p className="text-[11px] leading-relaxed text-gray-400">
          Nothing here needs you — this is the work being done on your behalf, so you can see the
          deal is moving.
        </p>
        <ul className="space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-start gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-gray-300" />
              <p className="text-xs leading-relaxed text-gray-500">
                {t.title}
                {/* gray-400, not 300: the name is the whole point of the row —
                    "who is doing this?" has to be readable, not decorative. */}
                <span className="text-gray-400"> — {taskHandlerLabel(t.assignedTo)}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
