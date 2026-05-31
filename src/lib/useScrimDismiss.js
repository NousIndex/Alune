import { useRef } from "react";

// Props for a modal backdrop ("scrim") that dismisses only on a genuine click
// that BOTH starts and ends on the scrim itself. This prevents the common
// annoyance where drag-selecting text inside the dialog and releasing the
// mouse over the backdrop (a "click" whose target is the scrim) closes it.
//
// Pass `enabled = false` to suppress dismissal entirely (e.g. while a modal is
// mid-operation and shouldn't be closed by an outside click).
export function useScrimDismiss(onClose, enabled = true) {
  const startedOnScrim = useRef(false);
  return {
    onMouseDown: (e) => {
      startedOnScrim.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      const onScrim = startedOnScrim.current && e.target === e.currentTarget;
      startedOnScrim.current = false;
      if (onScrim && enabled) onClose();
    },
  };
}
