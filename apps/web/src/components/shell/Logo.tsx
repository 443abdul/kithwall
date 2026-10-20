// Kithwall mark: two people (circles) sealed inside a rounded tile. Uses tokens via currentColor/CSS.
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="k-logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="10" className="k-logo-tile" />
      <circle cx="12.5" cy="14" r="5.5" className="k-logo-ring" />
      <circle cx="19.5" cy="18" r="5.5" className="k-logo-ring" />
    </svg>
  );
}

export function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="k-logo">
      <LogoMark size={size} />
      {wordmark ? <span className="k-logo-word" translate="no">kithwall</span> : <span className="k-sr-only">Kithwall</span>}
    </span>
  );
}
