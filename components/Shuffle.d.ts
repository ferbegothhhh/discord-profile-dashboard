import type { CSSProperties, ElementType, JSX } from "react";

type ShuffleProps = {
  text: string;
  className?: string;
  style?: CSSProperties;
  shuffleDirection?: "right" | "left" | "up" | "down";
  duration?: number;
  maxDelay?: number;
  ease?: string;
  threshold?: number;
  rootMargin?: string;
  tag?: ElementType;
  textAlign?: CSSProperties["textAlign"];
  onShuffleComplete?: () => void;
  shuffleTimes?: number;
  animationMode?: "evenodd" | "center" | "sequence" | "random";
  loop?: boolean;
  loopDelay?: number;
  stagger?: number;
  scrambleCharset?: string;
  colorFrom?: string;
  colorTo?: string;
  triggerOnce?: boolean;
  respectReducedMotion?: boolean;
  triggerOnHover?: boolean;
  effect?: "slide" | "flip" | "blur";
  hoverRadius?: number;
  motionBlur?: boolean;
  color?: string;
  accentColor?: string;
};

declare function Shuffle(props: ShuffleProps): JSX.Element;

export default Shuffle;
