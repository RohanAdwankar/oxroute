export type IconName =
  | "archive"
  | "ask"
  | "attach"
  | "auto"
  | "back"
  | "collapse"
  | "discard"
  | "expand"
  | "external"
  | "fork"
  | "keyboard"
  | "merge"
  | "open"
  | "pin"
  | "play"
  | "plus"
  | "quote"
  | "restore"
  | "send"
  | "stop"
  | "thread"
  | "unpin";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    archive: <><path d="M3 6h10v8H3z" /><path d="M2 3h12v3H2zM6 9h4" /></>,
    ask: <><path d="M8 14a6 6 0 1 0-6-6" /><path d="M2 3v5h5" /></>,
    attach: <path d="M6 8.5 10.5 4a2.1 2.1 0 0 1 3 3L7 13.5a3.2 3.2 0 0 1-4.5-4.5L9 2.5" />,
    auto: <><path d="m8 1 1.2 3.8L13 6l-3.8 1.2L8 11 6.8 7.2 3 6l3.8-1.2Z" /><path d="m13 11 .6 1.8 1.4.7-1.4.7L13 16l-.6-1.8-1.4-.7 1.4-.7Z" /></>,
    back: <path d="m10.5 3-5 5 5 5M5.5 8H15" />,
    collapse: <path d="m10 3-5 5 5 5" />,
    discard: <><path d="M3 5h10M6 5V3h4v2M5 5l.6 9h4.8l.6-9" /></>,
    expand: <path d="m6 3 5 5-5 5" />,
    external: <><path d="M9 3h4v4M13 3 7 9" /><path d="M12 9v4H3V4h4" /></>,
    fork: <><circle cx="5" cy="3" r="1.5" /><circle cx="11" cy="13" r="1.5" /><circle cx="5" cy="13" r="1.5" /><path d="M5 4.5v7M5 7h3a3 3 0 0 1 3 3v1.5" /></>,
    keyboard: <><rect x="1.5" y="3" width="13" height="10" rx="1" /><path d="M4 6h.01M7 6h.01M10 6h.01M13 6h.01M4 9h.01M7 9h5" /></>,
    merge: <><circle cx="5" cy="3" r="1.5" /><circle cx="11" cy="3" r="1.5" /><circle cx="8" cy="13" r="1.5" /><path d="M5 4.5v2A3.5 3.5 0 0 0 8 10v1.5M11 4.5v2A3.5 3.5 0 0 1 8 10" /></>,
    open: <path d="m6 3 5 5-5 5M2 8h9" />,
    pin: <path d="m5 2 6 6-2 1 3 3-1 1-3-3-1 2-6-6 2-1Z" />,
    play: <path d="m5 3 8 5-8 5Z" />,
    plus: <path d="M8 2v12M2 8h12" />,
    quote: <path d="M3 4h4v4H5a3 3 0 0 1-3 3M10 4h4v4h-2a3 3 0 0 1-3 3" />,
    restore: <><path d="M3 6h10v8H3z" /><path d="M2 3h12v3H2zM8 12V8M6 10l2-2 2 2" /></>,
    send: <path d="m2 2 12 6-12 6 2-6Zm2 6h6" />,
    stop: <rect x="3" y="3" width="10" height="10" rx="1" />,
    thread: <><path d="M2 3h9v7H6l-3 3v-3H2z" /><path d="M8 6h6v6h-2v2l-2-2H8" /></>,
    unpin: <><path d="m5 2 6 6-2 1 3 3-1 1-3-3-1 2-6-6 2-1Z" /><path d="m2 14 12-12" /></>,
  };

  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
