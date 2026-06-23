"use client";

import { useRef } from "react";
import { motion, useMotionValue, useTransform, animate } from "framer-motion";
import Image from "next/image";
import type { Recommendation, Trait } from "@/lib/api";

interface Props {
  rec: Recommendation;
  traits: Trait[];
  onDecide: (recId: number, status: "accepted" | "rejected" | "already_read") => void;
  /** z-index layer; top card = highest */
  zIndex?: number;
  /** Cards behind the top are slightly scaled down */
  isTop: boolean;
}

const DRAG_THRESHOLD = 120; // px before a swipe commits

export default function SwipeCard({ rec, traits, onDecide, zIndex = 0, isTop }: Props) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 250], [-18, 18]);

  // Overlay opacities
  const acceptOpacity = useTransform(x, [0, DRAG_THRESHOLD], [0, 1]);
  const rejectOpacity = useTransform(x, [-DRAG_THRESHOLD, 0], [1, 0]);

  // Matched traits (intersection of grounded_trait_ids with loaded traits)
  const traitIds = new Set(rec.grounded_trait_ids ?? []);
  const matchedTraits = traits.filter((t) => traitIds.has(t.id)).slice(0, 5);

  const cardRef = useRef<HTMLDivElement>(null);

  async function flyOff(direction: "left" | "right") {
    const target = direction === "right" ? 600 : -600;
    await animate(x, target, { duration: 0.35, ease: "easeOut" });
    onDecide(rec.id, direction === "right" ? "accepted" : "rejected");
  }

  function handleDragEnd() {
    const val = x.get();
    if (val > DRAG_THRESHOLD) {
      void flyOff("right");
    } else if (val < -DRAG_THRESHOLD) {
      void flyOff("left");
    } else {
      // Snap back
      animate(x, 0, { type: "spring", stiffness: 300, damping: 25 });
    }
  }

  return (
    <motion.div
      ref={cardRef}
      style={{ x, rotate, zIndex }}
      drag={isTop ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={handleDragEnd}
      animate={isTop ? {} : { scale: 0.95, y: 8 }}
      className={[
        "drag-card absolute inset-0 mx-auto max-w-sm w-full",
        "rounded-2xl border border-slate-700 bg-[#1a1f2e] shadow-2xl",
        "select-none overflow-hidden",
      ].join(" ")}
    >
      {/* Accept overlay */}
      <motion.div
        style={{ opacity: acceptOpacity }}
        className="pointer-events-none absolute inset-0 z-10 flex items-start justify-end rounded-2xl border-4 border-green-500 p-4"
      >
        <span className="rotate-12 rounded-lg bg-green-500 px-3 py-1 text-lg font-bold text-white">
          LIKE
        </span>
      </motion.div>

      {/* Reject overlay */}
      <motion.div
        style={{ opacity: rejectOpacity }}
        className="pointer-events-none absolute inset-0 z-10 flex items-start justify-start rounded-2xl border-4 border-red-500 p-4"
      >
        <span className="-rotate-12 rounded-lg bg-red-500 px-3 py-1 text-lg font-bold text-white">
          NOPE
        </span>
      </motion.div>

      {/* Cover image */}
      <div className="relative h-56 w-full bg-slate-800">
        {rec.cover_url ? (
          <Image
            src={rec.cover_url}
            alt={`Cover of ${rec.title}`}
            fill
            className="object-contain"
            draggable={false}
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl text-slate-600">
            📚
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-5 space-y-3">
        <div>
          <h2 className="text-lg font-bold leading-tight text-white">{rec.title}</h2>
          <p className="text-sm text-slate-400">
            {rec.author ?? "Unknown author"}
            {rec.year ? ` · ${rec.year}` : ""}
          </p>
        </div>

        {/* Subjects */}
        {rec.subjects && rec.subjects.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {rec.subjects.slice(0, 4).map((s) => (
              <span
                key={s}
                className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
              >
                {s}
              </span>
            ))}
          </div>
        )}

        {/* Rationale */}
        {rec.rationale && (
          <p className="text-sm leading-relaxed text-slate-300 line-clamp-4">
            {rec.rationale}
          </p>
        )}

        {/* Matched taste traits */}
        {matchedTraits.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Matched taste
            </p>
            <div className="flex flex-wrap gap-1.5">
              {matchedTraits.map((t) => (
                <span
                  key={t.id}
                  className={[
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium",
                    t.polarity === "reward"
                      ? "border-blue-700 bg-blue-900/40 text-blue-300"
                      : "border-amber-700 bg-amber-900/40 text-amber-300",
                  ].join(" ")}
                  title={t.claim}
                >
                  {t.claim.length > 40 ? t.claim.slice(0, 38) + "…" : t.claim}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
