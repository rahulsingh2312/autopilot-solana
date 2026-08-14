import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  FAINT,
  FONT_MONO,
  FONT_SANS,
  FONT_SERIF,
  GRAD_A,
  GRAD_B,
  INK,
  MUTED,
  PAPER,
  PEARL_A,
  PEARL_B,
  PEARL_C,
  PEARL_GRAD,
  POS,
  RULE,
} from "./theme";

/* ── Scene timing (30fps), cut to the 22.6s reference track ───────── */
const WALL = { from: 0, dur: 60 };
const PROBLEM = { from: 60, dur: 66 };
const COIN_TITLE = { from: 126, dur: 66 };
const COMPONENTS = { from: 192, dur: 114 };
const MUTATION = { from: 306, dur: 90 };
const CHAIN = { from: 396, dur: 60 };
const PNL = { from: 456, dur: 84 };
const TAGLINE = { from: 540, dur: 54 };
const OUTRO = { from: 594, dur: 84 };
export const PROMO_DURATION = OUTRO.from + OUTRO.dur; // 678 frames = 22.6s

/* ── Shared bits ──────────────────────────────────────────────────── */

const Paper: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: PAPER,
      backgroundImage: [
        "radial-gradient(circle at 1px 1px, rgb(10 10 10 / 0.07) 1px, transparent 0)",
        "radial-gradient(46% 40% at 12% 6%, rgb(0 255 163 / 0.16), transparent 70%)",
        "radial-gradient(50% 44% at 86% 2%, rgb(220 31 255 / 0.14), transparent 72%)",
        "radial-gradient(58% 48% at 6% 58%, rgb(0 255 163 / 0.10), transparent 72%)",
        "radial-gradient(64% 52% at 92% 66%, rgb(220 31 255 / 0.10), transparent 74%)",
      ].join(","),
      backgroundSize: "24px 24px, auto, auto, auto, auto",
    }}
  >
    {children}
  </AbsoluteFill>
);

const useRise = (delay: number, distance = 46) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return {
    opacity: s,
    transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)`,
  };
};

const useBob = (amp = 7, speed = 0.09, phase = 0) => {
  const frame = useCurrentFrame();
  return {
    x: Math.sin(frame * speed + phase) * amp,
    y: Math.cos(frame * speed * 0.83 + phase * 1.7) * amp,
    rot: Math.sin(frame * speed * 0.61 + phase) * 0.7,
  };
};

const Push: React.FC<{ from?: number; to?: number; children: React.ReactNode }> = ({
  from = 1,
  to = 1.08,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [from, to]);
  return <AbsoluteFill style={{ transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
};

const WALL_IMAGES = [
  "buffett.jpg",
  "tokens/pltsol.png",
  "pelosi.jpg",
  "cramer.jpg",
  "tokens/mbtsol.png",
  "tepper.jpg",
  "capitol.jpg",
  "tokens/icsol.png",
  "dalio.jpg",
  "ackman.jpg",
  "tokens/cgsol.png",
  "burry.jpg",
  "simons.jpg",
  "tokens/aisol.png",
  "tokens/bwsol.png",
  "tokens/mg7sol.png",
  "tokens/jstsol.png",
  "tokens/psqsol.png",
];

const FaceTicker: React.FC<{ bottom?: number; opacity?: number }> = ({
  bottom = -30,
  opacity = 0.3,
}) => {
  const frame = useCurrentFrame();
  const size = 130;
  const gap = 24;
  const span = WALL_IMAGES.length * (size + gap);
  const x = -((frame * 7) % span);
  return (
    <div
      style={{
        position: "absolute",
        bottom,
        left: 0,
        display: "flex",
        gap,
        transform: `translateX(${x}px)`,
        opacity,
      }}
    >
      {[...WALL_IMAGES, ...WALL_IMAGES, ...WALL_IMAGES].map((img, i) => (
        <div
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size,
            overflow: "hidden",
            flexShrink: 0,
            border: "1px solid rgba(250,250,248,0.2)",
          }}
        >
          <Img
            src={staticFile(img)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: "grayscale(1) contrast(1.1)",
            }}
          />
        </div>
      ))}
    </div>
  );
};

const Punch: React.FC<{
  lines: { text: string; gradient?: boolean }[];
  color: string;
  size?: number;
  delay?: number;
}> = ({ lines, color, size = 92, delay = 0 }) => (
  <div
    style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
  >
    {lines.map((line, i) => (
      <PunchLine
        key={line.text}
        text={line.text}
        delay={delay + i * 7}
        style={{
          fontFamily: FONT_SANS,
          fontWeight: 800,
          fontSize: size,
          lineHeight: 1.06,
          letterSpacing: "-0.02em",
          textAlign: "center",
          color,
          ...(line.gradient
            ? {
                backgroundImage: PEARL_GRAD,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }
            : {}),
        }}
      />
    ))}
  </div>
);

const PunchLine: React.FC<{
  text: string;
  delay: number;
  style: React.CSSProperties;
}> = ({ text, delay, style }) => {
  const rise = useRise(delay);
  return <div style={{ ...style, ...rise }}>{text}</div>;
};

const MonoLabel: React.FC<{
  text: string;
  color?: string;
  delay?: number;
  size?: number;
}> = ({ text, color = FAINT, delay = 0, size = 22 }) => {
  const rise = useRise(delay, 20);
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontSize: size,
        letterSpacing: "0.22em",
        color,
        textTransform: "uppercase",
        ...rise,
      }}
    >
      {text}
    </div>
  );
};

/* ── Coin: gradient-rimmed disc with continuous 3D tilt ───────────── */

const Coin: React.FC<{
  face: React.ReactNode;
  size: number;
  phase?: number;
  tiltAmp?: number;
  bare?: boolean;
}> = ({ face, size, phase = 0, tiltAmp = 24, bare = false }) => {
  const frame = useCurrentFrame();
  const ry = Math.sin(frame * 0.085 + phase) * tiltAmp;
  const rz = Math.sin(frame * 0.062 + phase * 1.7) * 7;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        position: "relative",
        transform: `perspective(1400px) rotateY(${ry}deg) rotateZ(${rz}deg)`,
        boxShadow: "0 34px 70px rgba(10,10,10,0.22)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          padding: bare ? 0 : size * 0.045,
          backgroundImage: bare ? undefined : PEARL_GRAD,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: "50%",
            overflow: "hidden",
            backgroundColor: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {face}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          backgroundImage: `linear-gradient(${105 + ry * 2.2}deg, rgba(255,255,255,0) 32%, rgba(255,255,255,0.4) 47%, rgba(255,255,255,0) 62%)`,
        }}
      />
    </div>
  );
};

// The exact Solana logomark the site uses (sol-mark.tsx), on a white coin face.
const SolFace: React.FC = () => (
  <div
    style={{
      width: "100%",
      height: "100%",
      backgroundColor: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <svg viewBox="0 0 398 312" style={{ width: "46%" }}>
      <defs>
        <linearGradient id="solg" x1="0" y1="312" x2="398" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={GRAD_A} />
          <stop offset="1" stopColor={GRAD_B} />
        </linearGradient>
      </defs>
      <path
        fill="url(#solg)"
        d="M64.6 237.9a13 13 0 0 1 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7zM64.6 3.8A13.3 13.3 0 0 1 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7a13 13 0 0 1-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8zM333.1 120.1a13 13 0 0 0-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7a13 13 0 0 0 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"
      />
    </svg>
  </div>
);

const TokenFace: React.FC<{ img: string }> = ({ img }) => (
  <Img
    src={staticFile(img)}
    style={{ width: "100%", height: "100%", objectFit: "cover" }}
  />
);

/* ── ShotZoom: screenshot in a card, camera pushes toward a target ── */

const ShotZoom: React.FC<{
  src: string;
  cardW: number;
  cardH: number;
  origin: string;
  scaleFrom: number;
  scaleTo: number;
  tilt?: boolean;
  label?: string;
}> = ({ src, cardW, cardH, origin, scaleFrom, scaleTo, tilt = false, label }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [6, durationInFrames], [scaleFrom, scaleTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bob = useBob(4, 0.08, 1.2);
  const tiltY = tilt ? Math.sin(frame * 0.07) * 3 : bob.rot;
  const tiltX = tilt ? Math.cos(frame * 0.055) * 1.5 : 0;
  const labelRise = useRise(8, 24);
  return (
    <Paper>
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", gap: 36 }}
      >
        <div
          style={{
            width: cardW,
            height: cardH,
            borderRadius: 22,
            border: `1px solid ${RULE}`,
            overflow: "hidden",
            backgroundColor: "#fff",
            boxShadow: "0 30px 80px rgba(10,10,10,0.20)",
            opacity: enter,
            transform: `perspective(1600px) translateY(${interpolate(enter, [0, 1], [70, 0])}px) translate(${bob.x}px, ${bob.y}px) rotateY(${tiltY}deg) rotateX(${tiltX}deg)`,
          }}
        >
          <Img
            src={staticFile(src)}
            style={{
              width: "100%",
              display: "block",
              transform: `scale(${zoom})`,
              transformOrigin: origin,
            }}
          />
        </div>
        {label ? (
          <div
            style={{
              fontFamily: FONT_SERIF,
              fontStyle: "italic",
              fontSize: 56,
              color: INK,
              textAlign: "center",
              ...labelRise,
            }}
          >
            {label}
          </div>
        ) : null}
      </AbsoluteFill>
    </Paper>
  );
};

/* ── VideoZoom: demo clip in a browser card, camera pushes to a target ── */

const VideoZoom: React.FC<{
  src: string;
  origin: string;
  scaleFrom: number;
  scaleTo: number;
  label?: string;
  startFrom?: number;
  cardW?: number;
}> = ({ src, origin, scaleFrom, scaleTo, label, startFrom = 0, cardW = 960 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [4, durationInFrames], [scaleFrom, scaleTo], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bob = useBob(5, 0.07, 1.1);
  const labelRise = useRise(8, 24);
  return (
    <Paper>
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", gap: 36 }}
      >
        <div
          style={{
            width: cardW,
            borderRadius: 22,
            border: `1px solid ${RULE}`,
            overflow: "hidden",
            backgroundColor: "#fff",
            boxShadow: "0 30px 80px rgba(10,10,10,0.18)",
            opacity: enter,
            transform: `translateY(${interpolate(enter, [0, 1], [60, 0])}px) translate(${bob.x}px, ${bob.y}px) rotate(${bob.rot}deg)`,
          }}
        >
          <div
            style={{
              height: 44,
              display: "flex",
              alignItems: "center",
              gap: 9,
              paddingLeft: 20,
              borderBottom: `1px solid ${RULE}`,
              backgroundColor: PAPER,
            }}
          >
            {["#e7645f", "#e9b64c", "#67c15f"].map((c) => (
              <div
                key={c}
                style={{ width: 13, height: 13, borderRadius: 7, backgroundColor: c }}
              />
            ))}
            <div
              style={{ marginLeft: 16, fontFamily: FONT_MONO, fontSize: 17, color: FAINT }}
            >
              autopilotsol.vercel.app
            </div>
          </div>
          <div style={{ overflow: "hidden" }}>
            <OffthreadVideo
              src={staticFile(src)}
              startFrom={startFrom}
              playbackRate={1.2}
              muted
              style={{
                width: "100%",
                display: "block",
                transform: `scale(${zoom})`,
                transformOrigin: origin,
              }}
            />
          </div>
        </div>
        {label ? (
          <div
            style={{
              fontFamily: FONT_SERIF,
              fontStyle: "italic",
              fontSize: 56,
              color: INK,
              textAlign: "center",
              ...labelRise,
            }}
          >
            {label}
          </div>
        ) : null}
      </AbsoluteFill>
    </Paper>
  );
};

/* ── Scene 1: portrait wall, every coin tilting ───────────────────── */

const WallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const cell = 172;
  const gap = 26;
  const cols = 6;
  const perCol = 9;
  return (
    <Paper>
      <Push from={1.18} to={1}>
        <AbsoluteFill style={{ justifyContent: "center", overflow: "hidden" }}>
          <div style={{ display: "flex", gap, justifyContent: "center" }}>
            {Array.from({ length: cols }).map((_, c) => {
              const dir = c % 2 === 0 ? 1 : -1;
              const y = ((frame * 9 * dir) % ((cell + gap) * 3)) - (cell + gap) * 3;
              return (
                <div
                  key={c}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap,
                    transform: `translateY(${y}px)`,
                  }}
                >
                  {Array.from({ length: perCol }).map((__, r) => {
                    const img = WALL_IMAGES[(c * 7 + r * 5) % WALL_IMAGES.length];
                    const tilt = Math.sin(frame * 0.11 + c * 1.3 + r * 0.9) * 15;
                    return (
                      <div
                        key={r}
                        style={{
                          width: cell,
                          height: cell,
                          borderRadius: cell,
                          overflow: "hidden",
                          border: `1px solid ${RULE}`,
                          backgroundColor: "#fff",
                          flexShrink: 0,
                          transform: `perspective(900px) rotateY(${tilt}deg)`,
                        }}
                      >
                        <Img
                          src={staticFile(img)}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            filter: "grayscale(1)",
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Soft paper haze so the serif stays legible over the wall. */}
            <div
              style={{
                position: "absolute",
                width: 1080,
                height: 560,
                background:
                  "radial-gradient(50% 50% at 50% 50%, rgba(250,250,248,0.92) 30%, rgba(250,250,248,0.55) 60%, transparent 78%)",
                opacity: interpolate(frame, [6, 18], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            />
            <div
              style={{
                position: "relative",
                fontFamily: FONT_SERIF,
                fontStyle: "italic",
                fontSize: 104,
                lineHeight: 1.06,
                color: INK,
                textAlign: "center",
                opacity: interpolate(frame, [8, 20], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
                transform: `scale(${1 + Math.sin(frame * 0.09) * 0.012})`,
              }}
            >
              The most-watched
              <br />
              portfolios on earth.
            </div>
          </div>
        </AbsoluteFill>
      </Push>
    </Paper>
  );
};

/* ── Scene 2: problem cards (black) ───────────────────────────────── */

const ProblemScene: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: INK, overflow: "hidden" }}>
      <Push from={1} to={1.12}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Punch
            color={PAPER}
            size={80}
            lines={[
              { text: "PELOSI FILES." },
              { text: "BUFFETT FILES." },
              { text: "NOBODY CAN HOLD IT.", gradient: true },
            ]}
          />
        </AbsoluteFill>
        <FaceTicker />
      </Push>
    </AbsoluteFill>
  );
};

/* ── Scene 3: coin zoom-out reveals the title ─────────────────────── */

const CoinTitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const settle = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 38 });
  const scale = interpolate(settle, [0, 1], [2.6, 1]);
  const l1 = useRise(10, 40);
  const l2 = useRise(16, 40);
  return (
    <Paper>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 40,
          transform: `scale(${scale})`,
          transformOrigin: "50% 34%",
        }}
      >
        <Coin face={<TokenFace img="tokens/pltsol.png" />} size={330} tiltAmp={28} bare />
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontSize: 96,
            lineHeight: 1.06,
            color: INK,
            textAlign: "center",
          }}
        >
          <div style={l1}>Famous portfolios,</div>
          <div style={{ fontStyle: "italic", ...l2 }}>one token each.</div>
        </div>
        <MonoLabel text="pltSOL · PELOSI'S DISCLOSED BOOK, AS A COIN" delay={22} size={20} color={MUTED} />
      </AbsoluteFill>
    </Paper>
  );
};

/* ── Scene 4: component zooms (the Post-button move) ──────────────── */

const COMP_A = 60;

const ComponentsScene: React.FC = () => {
  const frame = useCurrentFrame();
  return frame < COMP_A ? (
    <VideoZoom
      src="clips/vault.mp4"
      origin="35% 35%"
      scaleFrom={1}
      scaleTo={1.25}
      label="Every vault."
    />
  ) : (
    <Sequence from={COMP_A} layout="none">
      <VideoZoom
        src="clips/buy.mp4"
        origin="29% 55%"
        scaleFrom={1.15}
        scaleTo={1.6}
        startFrom={45}
        label="Deposit SOL, get pltSOL."
      />
    </Sequence>
  );
};

/* ── Scene 5: SOL mutates into pltSOL, then back ──────────────────── */

const FLIP_AT = 52;

const SerifCaption: React.FC<{ text: string; delay?: number }> = ({ text, delay = 0 }) => {
  const rise = useRise(delay, 40);
  return (
    <div
      style={{
        fontFamily: FONT_SERIF,
        fontStyle: "italic",
        fontSize: 76,
        color: INK,
        textAlign: "center",
        ...rise,
      }}
    >
      {text}
    </div>
  );
};

const MutationScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const forward = frame < FLIP_AT;
  const beamFlow = -frame * 14;
  const tokenIn = spring({ frame: frame - 8, fps, config: { damping: 200 } });
  const topLabel = useRise(0, 20);
  // On the burn beat the coins trade places: pltSOL crosses to the left,
  // SOL to the right, arcing over/under each other.
  const swap = spring({ frame: frame - FLIP_AT, fps, config: { damping: 200 } });
  const swapX = interpolate(swap, [0, 1], [0, 572]);
  const arc = Math.sin(Math.PI * swap) * 90;
  return (
    <Paper>
      <Push from={1} to={1.1}>
        <AbsoluteFill
          style={{ alignItems: "center", justifyContent: "center", gap: 70 }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 21,
              letterSpacing: "0.22em",
              color: MUTED,
              ...topLabel,
            }}
          >
            ONE TRANSACTION IN · ONE TRANSACTION OUT
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 46 }}>
            <div
              style={{
                transform: `translate(${swapX}px, ${-arc}px)`,
                zIndex: 2,
                position: "relative",
              }}
            >
              <Coin face={<SolFace />} size={250} phase={0.4} />
            </div>
            <div style={{ position: "relative", width: 230, height: 10 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 5,
                  backgroundImage: `repeating-linear-gradient(90deg, ${PEARL_A} 0px, ${PEARL_B} 26px, transparent 26px, transparent 40px)`,
                  backgroundPositionX: beamFlow,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: -9,
                  right: -6,
                  width: 0,
                  height: 0,
                  borderTop: "14px solid transparent",
                  borderBottom: "14px solid transparent",
                  borderLeft: `20px solid ${PEARL_C}`,
                }}
              />
            </div>
            <div
              style={{
                transform: `translate(${-swapX}px, ${arc}px) perspective(1400px) rotateY(${interpolate(tokenIn, [0, 1], [90, 0])}deg)`,
                position: "relative",
              }}
            >
              <Coin face={<TokenFace img="tokens/pltsol.png" />} size={250} phase={2.1} bare />
            </div>
          </div>

          {forward ? (
            <SerifCaption text="Deposit SOL. It mints pltSOL." delay={4} />
          ) : (
            <Sequence from={FLIP_AT} layout="none">
              <SerifCaption text="Burn pltSOL. SOL again." delay={0} />
            </Sequence>
          )}
        </AbsoluteFill>
      </Push>
    </Paper>
  );
};

/* ── Scene 6: chain card (black) ──────────────────────────────────── */

const ChainScene: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: INK, overflow: "hidden" }}>
    <Push from={1} to={1.12}>
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", gap: 40 }}
      >
        <Punch
          color={PAPER}
          lines={[{ text: "WHEN THEY FILE," }, { text: "IT REBALANCES.", gradient: true }]}
        />
        <MonoLabel
          text="PYTH PRICES · JUPITER SWAPS · FULL CUSTODY"
          color="rgba(250,250,248,0.6)"
          delay={14}
          size={20}
        />
      </AbsoluteFill>
      <FaceTicker />
    </Push>
  </AbsoluteFill>
);

/* ── Scene 7: PnL tilt + the chain receipt ────────────────────────── */

const PNL_A = 48;

const PnlScene: React.FC = () => {
  const frame = useCurrentFrame();
  return frame < PNL_A ? (
    <ShotZoom
      src="shots/pnl.png"
      cardW={960}
      cardH={454}
      origin="13% 28%"
      scaleFrom={1.05}
      scaleTo={1.35}
      tilt
      label="+154%, beat SPY by 133%."
    />
  ) : (
    <Sequence from={PNL_A} layout="none">
      <VideoZoom
        src="clips/receipt.mp4"
        origin="40% 45%"
        scaleFrom={1.05}
        scaleTo={1.3}
        startFrom={90}
        label="The chain is the receipt."
      />
    </Sequence>
  );
};

/* ── Scene 8: tagline ─────────────────────────────────────────────── */

const TaglineScene: React.FC = () => {
  const frame = useCurrentFrame();
  const l1 = useRise(0, 50);
  const l2 = useRise(8, 50);
  const drift = Math.sin(frame * 0.06) * 10;
  return (
    <Paper>
      <Push from={1} to={1.12}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              fontFamily: FONT_SERIF,
              fontSize: 128,
              lineHeight: 1.08,
              color: INK,
              textAlign: "center",
            }}
          >
            <div style={{ ...l1, transform: `${l1.transform} translateX(${drift}px)` }}>
              Trade the trader,
            </div>
            <div
              style={{
                fontStyle: "italic",
                ...l2,
                transform: `${l2.transform} translateX(${-drift}px)`,
              }}
            >
              not the market.
            </div>
          </div>
        </AbsoluteFill>
      </Push>
    </Paper>
  );
};

/* ── Scene 9: outro ───────────────────────────────────────────────── */

const OUTRO_FACES = ["buffett.jpg", "pelosi.jpg", "cramer.jpg", "capitol.jpg", "tepper.jpg"];

const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const logo = useRise(0, 40);
  const faces = useRise(10, 30);
  const url = useRise(18, 24);
  const pulse = 1 + Math.sin(frame * 0.16) * 0.03;
  return (
    <Paper>
      <Push from={1} to={1.06}>
        <AbsoluteFill
          style={{ alignItems: "center", justifyContent: "center", gap: 44 }}
        >
          <div style={{ fontFamily: FONT_SERIF, fontSize: 160, color: INK, ...logo }}>
            Autopilot.
          </div>
          <div style={{ display: "flex", gap: 18, ...faces }}>
            {OUTRO_FACES.map((f, i) => (
              <div
                key={f}
                style={{
                  width: 108,
                  height: 108,
                  borderRadius: 108,
                  overflow: "hidden",
                  border: `1px solid ${RULE}`,
                  backgroundColor: "#fff",
                  transform: `translateY(${Math.sin(frame * 0.12 + i * 1.4) * 8}px) perspective(800px) rotateY(${Math.sin(frame * 0.1 + i) * 12}deg)`,
                }}
              >
                <Img
                  src={staticFile(f)}
                  style={{ width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(1)" }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, ...url }}>
            <div
              style={{
                padding: "20px 40px",
                borderRadius: 999,
                backgroundImage: PEARL_GRAD,
                boxShadow:
                  "inset 0 1px 0 rgb(255 255 255 / 0.65), 0 12px 28px -16px rgb(150 110 230 / 0.55)",
                fontFamily: FONT_MONO,
                fontSize: 27,
                fontWeight: 700,
                color: INK,
                transform: `scale(${pulse})`,
              }}
            >
              autopilotsol.vercel.app
            </div>
            <MonoLabel text="LIVE ON DEVNET · MAINNET SOON" color={FAINT} delay={22} size={19} />
          </div>
        </AbsoluteFill>
      </Push>
    </Paper>
  );
};

/* ── Assembly ─────────────────────────────────────────────────────── */

export const Promo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      <Audio src={staticFile("track.m4a")} />
      <Sequence from={WALL.from} durationInFrames={WALL.dur}>
        <WallScene />
      </Sequence>
      <Sequence from={PROBLEM.from} durationInFrames={PROBLEM.dur}>
        <ProblemScene />
      </Sequence>
      <Sequence from={COIN_TITLE.from} durationInFrames={COIN_TITLE.dur}>
        <CoinTitleScene />
      </Sequence>
      <Sequence from={COMPONENTS.from} durationInFrames={COMPONENTS.dur} premountFor={30}>
        <ComponentsScene />
      </Sequence>
      <Sequence from={MUTATION.from} durationInFrames={MUTATION.dur}>
        <MutationScene />
      </Sequence>
      <Sequence from={CHAIN.from} durationInFrames={CHAIN.dur}>
        <ChainScene />
      </Sequence>
      <Sequence from={PNL.from} durationInFrames={PNL.dur} premountFor={30}>
        <PnlScene />
      </Sequence>
      <Sequence from={TAGLINE.from} durationInFrames={TAGLINE.dur}>
        <TaglineScene />
      </Sequence>
      <Sequence from={OUTRO.from} durationInFrames={OUTRO.dur}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};
