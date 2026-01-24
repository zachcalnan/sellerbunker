"use client";

type FlagProps = { className?: string };

export function FlagGB({ className }: FlagProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 480"
      className={className}
      aria-hidden
    >
      <path fill="#012169" d="M0 0h640v480H0z" />
      <path
        fill="#FFF"
        d="m75 0 244 181L562 0h78v62L400 241l240 178v61h-80L320 301 81 480H0v-60l239-178L0 64V0h75z"
      />
      <path
        fill="#C8102E"
        d="m424 281 216 159v40L369 281h55zm-184 20 6 35L54 480H0l240-179zM640 0v3L391 191l2-44L590 0h50zM0 0l239 176h-60L0 42V0z"
      />
      <path fill="#FFF" d="M241 0v480h160V0H241zM0 160v160h640V160H0z" />
      <path fill="#C8102E" d="M0 193v96h640v-96H0zM273 0v480h96V0h-96z" />
    </svg>
  );
}

export function FlagDE({ className }: FlagProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 480"
      className={className}
      aria-hidden
    >
      <path fill="#ffce00" d="M0 320h640v160H0z" />
      <path d="M0 0h640v160H0z" />
      <path fill="#d00" d="M0 160h640v160H0z" />
    </svg>
  );
}

export function FlagFR({ className }: FlagProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 480"
      className={className}
      aria-hidden
    >
      <g fillRule="evenodd" strokeWidth={1}>
        <path fill="#fff" d="M0 0h640v480H0z" />
        <path fill="#002654" d="M0 0h213.3v480H0z" />
        <path fill="#ce1126" d="M426.7 0H640v480H426.7z" />
      </g>
    </svg>
  );
}

export function FlagES({ className }: FlagProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 480"
      className={className}
      aria-hidden
    >
      <path fill="#AA151B" d="M0 0h640v480H0z" />
      <path fill="#F1BF00" d="M0 120h640v240H0z" />
    </svg>
  );
}

const FLAG_MAP = {
  gb: FlagGB,
  es: FlagES,
  de: FlagDE,
  fr: FlagFR,
} as const;

export type FlagCode = keyof typeof FLAG_MAP;

export function FlagIcon({
  code,
  className,
}: {
  code: FlagCode;
  className?: string;
}) {
  const Flag = FLAG_MAP[code];
  return Flag ? <Flag className={className} /> : null;
}
