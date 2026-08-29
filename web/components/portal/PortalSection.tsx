'use client';

/**
 * A titled region of a client portal (#422).
 *
 * The portals used to be an undifferentiated stack of cards: a task the client
 * had to do sat in the same visual register as a card telling them their
 * appraisal had been ordered. Every group of cards now sits under a heading
 * that says whose job it is, so "what do I need to do" is answerable at a
 * glance and anything the client can't act on reads as informational.
 *
 * Deliberately dumb: a heading, a blurb, and whatever cards the portal puts
 * inside. It never decides what goes in a section — the portals do.
 */

import type { ReactNode } from 'react';

export default function PortalSection({
  title,
  blurb,
  testId,
  children,
}: {
  title: string;
  /** One line saying what this group is, and who drives it. */
  blurb?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} aria-label={title} className="space-y-3">
      <div className="px-0.5">
        <h2 className="text-sm font-black uppercase tracking-wide text-brand-navy">{title}</h2>
        {blurb && <p className="mt-1 text-xs leading-relaxed text-gray-400">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}
