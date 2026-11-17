import type { ReactNode } from 'react';

/* ---------- 16x16 line icons (stroke=currentColor) shared by the Settings /
   Market rails — one set so every rail item looks alike ---------- */
const I = (path: ReactNode): ReactNode => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

export const ICONS = {
  general: I(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  ),
  remote: I(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </>,
  ),
  team: I(
    <>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3 19c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" />
      <circle cx="17" cy="8" r="2.6" />
      <path d="M21 16c-.5-1.7-1.8-2.6-3.5-2.7" />
    </>,
  ),
  appearance: I(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18 6 6 0 0 1 0-12 6 6 0 0 1 0-6Z" />
    </>,
  ),
  providers: I(<path d="M5 5h6v6H5zM13 5h6v6h-6zM5 13h6v6H5zM13 13h6v6h-6z" />),
  /** speech bubble with lines — the prompts the app sends */
  prompt: I(
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5v-9Z" />
      <path d="M8 8.5h8M8 11.5h5" />
    </>,
  ),
  /** two arrows chasing each other — cross-device sync */
  sync: I(
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 21v-5h-5" />
    </>,
  ),
  /** open book — the human's knowledge base */
  book: I(
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-1.6H5.5A1.5 1.5 0 0 1 4 16V5.5Z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-1.6h4.5A1.5 1.5 0 0 0 20 16V5.5Z" />
    </>,
  ),
  /** puzzle piece — skills */
  puzzle: I(
    <path d="M10 4a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1h4V4Z" />,
  ),
} as const;
