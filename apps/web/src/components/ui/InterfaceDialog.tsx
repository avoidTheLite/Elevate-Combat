import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function InterfaceDialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [previous] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const box = ref.current;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab' || !box) return;
      const targets = [
        ...box.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ];
      const first = targets[0],
        last = targets.at(-1);
      if (!box.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [previous]);
  return (
    <div ref={ref} className="interface-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div className="interface-dialog flex flex-col gap-3">{children}</div>
    </div>
  );
}
