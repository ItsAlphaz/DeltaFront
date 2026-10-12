export const ACTIVE_CARD =
  "bg-df-red/20 border-df-red/50 shadow-[var(--shadow-df-red)]";
export const INACTIVE_CARD =
  "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20";
export const INPUT_CLASS =
  "w-full text-center rounded bg-black/60 text-white text-sm font-bold border border-white/20 focus:outline-none focus:border-df-red p-1 my-1";
export const CARD_LABEL_CLASS =
  "text-xs uppercase font-bold tracking-wider leading-tight break-words hyphens-auto";

export function cardClass(active: boolean, extra = ""): string {
  return `w-full h-full rounded-xl border cursor-pointer transition-all duration-200 active:scale-95 relative overflow-hidden ${extra} ${active ? ACTIVE_CARD : INACTIVE_CARD}`;
}
