interface ToggleSwitchProps {
  pressed?: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  label?: string;
}

export function ToggleSwitch({ pressed = true, onToggle, disabled = false, label }: ToggleSwitchProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label ? `Toggle ${label}` : undefined}
      title={label ? `Toggle ${label}` : undefined}
      className={`w-10 h-6 rounded-full transition-all duration-300 flex items-center shrink-0 ${pressed ? 'bg-[var(--accent)]' : 'bg-zinc-800'} ${onToggle ? 'cursor-pointer' : 'cursor-default'} ${disabled ? 'opacity-50' : ''}`}
    >
      <span className={`block w-4.5 h-4.5 rounded-full bg-white transition-all duration-300 shadow-md ${pressed ? 'ml-[18px]' : 'ml-[3px]'}`} />
    </button>
  );
}
