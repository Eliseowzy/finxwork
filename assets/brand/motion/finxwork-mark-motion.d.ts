export interface MarkMotionOptions {
  /** The ground it sits on: "auto" follows the system's appearance (the default). */
  theme?: "dark" | "light" | "auto";
  /** "strands": the data-point mark, for 96 px and up. "solid": smaller sizes, a light running along it. */
  look?: "strands" | "solid";
  /** 1 takes a data point along the whole stroke in 18 s. */
  speed?: number;
  /** First write the stroke on in writing order. */
  intro?: boolean;
  /** The solid mark written on, held and faded over and over (3 s a round), for something in progress. */
  rewrite?: boolean;
}

/** Draws the mark into a canvas sized by CSS and keeps it moving until stop(); one still frame with reduced motion. */
export function animateMark(canvas: HTMLCanvasElement, options?: MarkMotionOptions): { stop(): void };

/** One frame into ctx, size × size device pixels from the current origin, t seconds into the motion. */
export function drawMarkFrame(
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  options?: { theme?: "dark" | "light"; look?: "strands" | "solid"; reveal?: number },
): void;
