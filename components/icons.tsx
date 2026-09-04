import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Camera = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.2-1.8A1 1 0 0 1 10 3.8h4a1 1 0 0 1 .8.4L16 6h1.5A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.2" />
  </Icon>
);

export const ImageSquare = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="M20 15.5l-4.5-4.5-6 6.5-2.5-2.5L4 18" />
  </Icon>
);

export const X = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const CheckCircle = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.3 2.3L15.8 9.8" />
  </Icon>
);

export const Alert = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17.5v.1" />
  </Icon>
);

export const ChevronDown = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const ArrowRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const Rows = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="5" width="16" height="4.5" rx="1.5" />
    <rect x="4" y="14.5" width="16" height="4.5" rx="1.5" />
  </Icon>
);

export const Scan = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M7 12h10" />
  </Icon>
);

export const Trash = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7" />
  </Icon>
);

export const Pencil = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20l4.2-.9L19 8.3a1.5 1.5 0 0 0 0-2.1L17.8 5a1.5 1.5 0 0 0-2.1 0L4.9 15.8z" />
    <path d="M14.5 6.5l3 3" />
  </Icon>
);

export const Search = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </Icon>
);

export const User = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);

export const Spark = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Icon>
);
