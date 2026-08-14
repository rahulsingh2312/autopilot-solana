import { loadFont as loadInstrument } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

const instrument = loadInstrument();
const inter = loadInter();
const jetbrains = loadJetBrains();

export const FONT_SERIF = instrument.fontFamily;
export const FONT_SANS = inter.fontFamily;
export const FONT_MONO = jetbrains.fontFamily;

export const INK = "#0a0a0a";
export const PAPER = "#fafaf8";
export const MUTED = "#5c5b57";
export const FAINT = "#8a8983";
export const RULE = "#e7e6e1";
export const POS = "#0ba05f";
export const GRAD_A = "#00ffa3";
export const GRAD_B = "#dc1fff";
export const GRAD_A_INK = "#00b374";
export const GRAD_B_INK = "#a812c4";

/* The site's .btn-grad "mother-of-pearl" pastel — the lighter gradient used
   on every primary button. Use this for accents; the vivid OG stops stay
   reserved for the Solana logomark itself. */
export const PEARL_GRAD =
  "linear-gradient(100deg, #b6f2d8 0%, #cfe6fb 30%, #ded0fa 60%, #f8cfe9 100%)";
export const PEARL_A = "#b6f2d8";
export const PEARL_B = "#ded0fa";
export const PEARL_C = "#f8cfe9";
