import { useRecorderEvents } from '../hooks/useRecorderEvents';

interface Props {
  toasts: ReturnType<typeof useRecorderEvents>['toasts'];
}

export function ToastStack({ toasts }: Props) {
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'saved' ? 'ok' : 'err'}`}>
          {t.kind === 'saved' ? '✓ ' : '⚠ '}
          {t.message}
        </div>
      ))}
    </div>
  );
}
