import type { JSX } from 'solid-js';

const P: Record<string, () => JSX.Element> = {
  select: () => <path d="M5 3l12 7-5.5 1.5L9 17z" />,
  hand: () => <path d="M8 11V5.5a1.5 1.5 0 013 0V10m0-4.5v-1a1.5 1.5 0 013 0V10m0-3.5a1.5 1.5 0 013 0V13a6 6 0 01-6 6h-1a6 6 0 01-5-2.7L3.5 13a1.5 1.5 0 012.4-1.8L8 13" />,
  arrow: () => <path d="M4 16L16 4m0 0H8m8 0v8" />,
  service: () => <rect x="3" y="5" width="14" height="10" rx="2" />,
  database: () => <><ellipse cx="10" cy="5" rx="6" ry="2.2" /><path d="M4 5v10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5" /></>,
  queue: () => <><rect x="2" y="6" width="16" height="8" rx="4" /><path d="M9 8.5v3M12 8.5v3M15 8.5v3" /></>,
  cache: () => <path d="M6 3h8l4 7-4 7H6l-4-7z" />,
  lb: () => <path d="M10 2l8 8-8 8-8-8z" />,
  client: () => <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M3 8h14" /></>,
  zone: () => <rect x="3" y="3" width="14" height="14" rx="3" stroke-dasharray="3 2.5" />,
  text: () => <path d="M5 5h10M10 5v11" />,
  undo: () => <path d="M7 4L3 8l4 4M3 8h9a5 5 0 010 10H9" />,
  redo: () => <path d="M13 4l4 4-4 4m4-4H8a5 5 0 000 10h3" />,
  plus: () => <path d="M10 4v12M4 10h12" />,
  minus: () => <path d="M4 10h12" />,
  fit: () => <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />,
  eye: () => <><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" /><circle cx="10" cy="10" r="2.3" /></>,
  eyeOff: () => <path d="M3 3l14 14M8.5 5c.5-.1 1-.2 1.5-.2 5 0 8 5.2 8 5.2a14 14 0 01-2.2 2.8M5.4 6.4C3.3 7.8 2 10 2 10s3 5.5 8 5.5c1.5 0 2.8-.5 3.9-1.1" />,
  up: () => <path d="M5 12l5-5 5 5" />,
  down: () => <path d="M5 8l5 5 5-5" />,
  trash: () => <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />,
  menu: () => <path d="M3 5h14M3 10h14M3 15h14" />,
  play: () => <path d="M6 4l10 6-10 6z" />,
  pause: () => <path d="M6 4v12M14 4v12" />,
  camera: () => <><path d="M3 7h3l1.5-2h5L14 7h3v9H3z" /><circle cx="10" cy="11.5" r="2.8" /></>,
  close: () => <path d="M5 5l10 10M15 5L5 15" />,
  help: () => <><circle cx="10" cy="10" r="7.5" /><path d="M8 8a2 2 0 113 1.7c-.7.4-1 .8-1 1.6M10 14v.1" /></>,
  bolt: () => <path d="M11 2L4 11h5l-1 7 7-9h-5z" />,
  flow: () => <path d="M2 10h3M8 10h3M14 10h4m-2-2l2 2-2 2" />,
  skull: () => <><path d="M10 3a6 6 0 00-6 6c0 2 1 3.3 2 4v2.5h8V13c1-.7 2-2 2-4a6 6 0 00-6-6z" /><circle cx="7.8" cy="9.5" r="1.1" /><circle cx="12.2" cy="9.5" r="1.1" /></>,
  layers: () => <path d="M10 3l8 4-8 4-8-4zM2 11l8 4 8-4" />,
};

export function Icon(props: { name: string; size?: number }) {
  return (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 20 20" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {P[props.name]?.()}
    </svg>
  );
}
