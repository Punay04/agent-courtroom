type IconProps = { className?: string };

const stroke = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function IconReplay({ className = "size-4" }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <path d="M13.2 8A5.2 5.2 0 1 1 11 3.6" />
      <path d="M11 1.8v2.2H8.8" />
    </svg>
  );
}

export function IconExternal({ className = "size-4" }: IconProps) {
  return (
    <svg {...stroke} className={className}>
      <path d="M6.5 3.5H3.8A1.3 1.3 0 0 0 2.5 4.8v7.4A1.3 1.3 0 0 0 3.8 13.5h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5" />
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

export function IconChevron({ className = "size-4", open = false }: IconProps & { open?: boolean }) {
  return (
    <svg {...stroke} className={`${className} transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}
