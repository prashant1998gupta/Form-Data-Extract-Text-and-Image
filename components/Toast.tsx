"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CheckCircle } from "./icons";

const TOAST_MS = 2600;

/**
 * A two-second confirmation for things that worked, the way CardLink reports
 * a save. Errors are not toasts — they stay on screen until acted on.
 */
export function useToast(): [React.ReactNode, (message: string) => void] {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((next: string) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const element = message ? (
    <div className="toast" role="status" aria-live="polite">
      <CheckCircle />
      <span>{message}</span>
    </div>
  ) : null;

  return [element, notify];
}
