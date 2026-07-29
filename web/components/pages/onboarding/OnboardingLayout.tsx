"use client";

import { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import UserMenu from '@/components/layout/UserMenu';

type Props = {
  progress: number; // 0–100
  onBack?: () => void;
  label: 'Buyer' | 'Seller' | 'Agent';
  stepLabel?: string; // e.g. "Step 3 of 11 · Your Profile"
  children: ReactNode;
};

export default function OnboardingLayout({ progress, onBack, label, stepLabel, children }: Props) {
  const labelStyle =
    label === 'Buyer'  ? 'bg-green-100 text-green-700' :
    label === 'Seller' ? 'bg-purple-100 text-purple-700' :
                         'bg-blue-100 text-blue-700';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#EEF2F7' }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-8 py-4">
        <span className="text-lg font-bold tracking-tight text-brand-navy">RealTour Flow</span>
        {/* Escape hatch: without it, someone who signed up with the wrong
            account is stuck in the wizard with no way to switch. */}
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${labelStyle}`}>
            {label}
          </span>
          <UserMenu showName={false} />
        </div>
      </div>

      {/* Card */}
      <div className="flex flex-1 justify-center px-4 pb-16 pt-2">
        <div className="w-full max-w-2xl">
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
            {/* Progress bar */}
            <div className="h-1 w-full bg-gray-100">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${Math.max(progress, 1)}%`,
                  background: label === 'Agent'
                    ? 'linear-gradient(90deg, #93c5fd 0%, #1d4ed8 100%)'
                    : 'linear-gradient(90deg, #86efac 0%, #16a34a 100%)',
                }}
              />
            </div>

            {/* Step label */}
            {stepLabel && (
              <div className="flex justify-center pt-3 pb-0">
                <span className="text-xs font-semibold text-gray-400 tracking-wide">{stepLabel}</span>
              </div>
            )}

            {/* Content */}
            <div className="min-h-[520px] px-8 pb-8 pt-10 sm:px-16">
              {children}
            </div>

            {/* Back */}
            {onBack && (
              <div className="pb-8 text-center">
                <button
                  onClick={onBack}
                  className="inline-flex items-center gap-1 text-sm text-gray-400 transition-colors hover:text-gray-600"
                >
                  <ChevronLeft size={14} /> Back
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
