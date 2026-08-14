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
  FONT_MONO,
  FONT_SANS,
  FONT_SERIF,
  PAPER,
  PEARL_GRAD,
  POS,
} from "./theme";

/*
 * Launch film — a shot-for-shot homage to Amir Dzhambulov's Autopilot launch
 * video, cut to its own music track. 1920x1080, premium-dark, tiny captions.
 * Scene timing mirrors the source edit so the music transitions land.
 */

const sec = (s: number) => Math.round(s * 30);

const TWEET = { from: 0, dur: sec(3.33) };
const WALL = { from: sec(3.33), dur: sec(5.0) - sec(3.33) };
const MACRO = { from: sec(5.0), dur: sec(6.63) - sec(5.0) };
const NOTIF = { from: sec(6.63), dur: sec(9.33) - sec(6.63) };
const STUDIO1 = { from: sec(9.33), dur: sec(10.5) - sec(9.33) };
const TUNNEL = { from: sec(10.5), dur: sec(14.9) - sec(10.5) };
const RESULT = { from: sec(14.9), dur: sec(18.0) - sec(14.9) };
const STUDIO2 = { from: sec(18.0), dur: sec(22.0) - sec(18.0) };
const NAME = { from: sec(22.0), dur: sec(24.0) - sec(22.0) };
const NOW = { from: sec(24.0), dur: sec(25.05) - sec(24.0) };
export const LAUNCH_DURATION = NOW.from + NOW.dur;

const BLACK = "#050506";

/* ── the tiny bottom caption, exactly like the reference ─────────── */

const Caption: React.FC<{ text: string; delay?: number }> = ({ text, delay = 4 }) => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [delay, delay + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 64,
        left: 0,
        right: 0,
        textAlign: "center",
        fontFamily: FONT_SANS,
        fontWeight: 400,
        fontSize: 30,
        color: "rgba(255,255,255,0.92)",
        opacity: o,
      }}
    >
      {text}
    </div>
  );
};

/* ── 1. tweet hook, typed live ───────────────────────────────────── */

const TWEET_TEXT = "everyone can read pelosi's trades. nobody can hold them.";

const TweetScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const chars = Math.floor(
    interpolate(frame, [10, 86], [0, TWEET_TEXT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const cursorOn = frame % 20 < 12;
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.04]);
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK }}>
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", transform: `scale(${drift})` }}
      >
        <div
          style={{
            width: 860,
            borderRadius: 20,
            backgroundColor: "#111214",
            border: "1px solid #222428",
            padding: "34px 38px",
            opacity: enter,
            transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
            boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Img
              src={staticFile("icon.png")}
              style={{ width: 58, height: 58, borderRadius: 58 }}
            />
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 27, color: "#e7e9ea" }}
                >
                  Autopilot Solana
                </span>
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="11" fill="#1d9bf0" />
                  <path
                    d="M7 12.5l3.2 3.2L17 9.4"
                    stroke="#fff"
                    strokeWidth="2.4"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 22, color: "#71767b" }}>
                @AutopilotxSOL
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 24,
              fontFamily: FONT_SANS,
              fontSize: 34,
              lineHeight: 1.35,
              color: "#e7e9ea",
              minHeight: 96,
            }}
          >
            {TWEET_TEXT.slice(0, chars)}
            <span style={{ opacity: cursorOn ? 1 : 0, color: "#e7e9ea" }}>▎</span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ── 2. screenshots floating in dark 3D space ────────────────────── */

const WALL_CARDS = [
  { src: "shots/cards.png", x: -520, y: -180, z: -300, ry: 18, rx: 4, w: 620 },
  { src: "shots/pnl.png", x: 420, y: -260, z: -140, ry: -16, rx: 6, w: 560 },
  { src: "shots/buypanel.png", x: -360, y: 150, z: -80, ry: 14, rx: -6, w: 380 },
  { src: "shots/receipt.png", x: 470, y: 210, z: -240, ry: -20, rx: -4, w: 600 },
  { src: "shots/cards.png", x: 40, y: -30, z: -520, ry: 8, rx: 2, w: 520 },
];

const WallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const push = interpolate(frame, [0, durationInFrames], [0, 190]);
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          perspective: 1100,
        }}
      >
        {WALL_CARDS.map((c, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              transform: `translate3d(${c.x}px, ${c.y + Math.sin(frame * 0.06 + i) * 8}px, ${c.z + push}px) rotateY(${c.ry}deg) rotateX(${c.rx}deg)`,
              width: c.w,
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 0 60px rgba(255,255,255,0.08), 0 30px 90px rgba(0,0,0,0.8)",
              opacity: 0.94,
            }}
          >
            <Img src={staticFile(c.src)} style={{ width: "100%", display: "block" }} />
          </div>
        ))}
      </AbsoluteFill>
      {/* vignette to keep edges dark like the reference */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(60% 60% at 50% 50%, transparent 40%, rgba(0,0,0,0.85) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ── 3 + 6. stolen footage beats ─────────────────────────────────── */

const Footage: React.FC<{ src: string; caption?: string; rate?: number }> = ({
  src,
  caption,
  rate = 1,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK }}>
      <OffthreadVideo
        src={staticFile(src)}
        muted
        playbackRate={rate}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {caption ? <Caption text={caption} /> : null}
    </AbsoluteFill>
  );
};

/* ── 4. dark notification panel ──────────────────────────────────── */

const NotifScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 4, fps, config: { damping: 200 } });
  const ry = -14 + Math.sin(frame * 0.045) * 3 + enter * 6;
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK, overflow: "hidden" }}>
      {/* faint sweep of light */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(${115 + frame * 0.2}deg, transparent 42%, rgba(255,255,255,0.05) 50%, transparent 58%)`,
        }}
      />
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", perspective: 1400 }}
      >
        <div
          style={{
            width: 760,
            borderRadius: 26,
            padding: "30px 34px",
            display: "flex",
            alignItems: "center",
            gap: 24,
            backgroundColor: "rgba(28,29,33,0.9)",
            border: "1px solid rgba(255,255,255,0.09)",
            boxShadow: "0 50px 140px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.08)",
            opacity: enter,
            transform: `rotateY(${ry}deg) rotateX(6deg) translateY(${interpolate(enter, [0, 1], [40, 0])}px)`,
          }}
        >
          <Img
            src={staticFile("icon.png")}
            style={{ width: 84, height: 84, borderRadius: 20 }}
          />
          <div style={{ flexGrow: 1 }}>
            <div
              style={{
                fontFamily: FONT_SANS,
                fontWeight: 600,
                fontSize: 30,
                color: "#f2f2f2",
              }}
            >
              Autopilot
            </div>
            <div style={{ fontFamily: FONT_SANS, fontSize: 26, color: "#9a9ba1", marginTop: 6 }}>
              New: the Pelosi Tracker is live
            </div>
          </div>
          <div style={{ fontFamily: FONT_SANS, fontSize: 22, color: "#6f7075" }}>now</div>
        </div>
      </AbsoluteFill>
      <Caption text="Introducing" />
    </AbsoluteFill>
  );
};

/* ── 5 + 8. studio scenes: grey plate + our screen ───────────────── */

const StudioPlate: React.FC<{ children: React.ReactNode; caption: string }> = ({
  children,
  caption,
}) => {
  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 90% at 50% 8%, #e8e8e8 0%, #cfcfcf 42%, #8f8f8f 78%, #6f6f6f 100%)",
      }}
    >
      {/* floor shadow line */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: "72%",
          bottom: 0,
          background: "linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.30))",
        }}
      />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        {children}
      </AbsoluteFill>
      <Caption text={caption} />
    </AbsoluteFill>
  );
};

const Studio1: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.07]);
  return (
    <StudioPlate caption="The Pelosi Tracker">
      <div
        style={{
          width: 660,
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.15)",
          boxShadow: "0 50px 110px rgba(0,0,0,0.45), 0 6px 18px rgba(0,0,0,0.25)",
          opacity: enter,
          transform: `scale(${zoom}) translateY(${interpolate(enter, [0, 1], [50, 0])}px)`,
        }}
      >
        <Img src={staticFile("shots/pnl.png")} style={{ width: "100%", display: "block" }} />
      </div>
    </StudioPlate>
  );
};

const Studio2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [0, durationInFrames], [1, 1.12]);
  return (
    <StudioPlate caption="Pick a portfolio">
      <div
        style={{
          width: 1150,
          borderRadius: 18,
          overflow: "hidden",
          border: "1px solid rgba(0,0,0,0.15)",
          boxShadow: "0 60px 130px rgba(0,0,0,0.5), 0 8px 22px rgba(0,0,0,0.25)",
          opacity: enter,
          transform: `scale(${zoom}) translateY(${interpolate(enter, [0, 1], [60, 0])}px)`,
          transformOrigin: "50% 40%",
        }}
      >
        <OffthreadVideo
          src={staticFile("clips/vault.mp4")}
          muted
          playbackRate={1.1}
          style={{ width: "100%", display: "block" }}
        />
      </div>
    </StudioPlate>
  );
};

/* ── 7. the result counter ───────────────────────────────────────── */

const ResultScene: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.round(
    interpolate(frame, [8, 58], [0, 154], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const glow = 1 + Math.sin(frame * 0.12) * 0.012;
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 26,
          transform: `scale(${glow})`,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontWeight: 700,
            fontSize: 260,
            color: POS,
            textShadow: "0 0 90px rgba(11,160,95,0.35)",
          }}
        >
          +{n}%
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: 30, color: "rgba(255,255,255,0.55)" }}>
          her disclosed book, one year · S&P did +21.1%
        </div>
      </AbsoluteFill>
      <Caption text="To see if she outperforms the market" />
    </AbsoluteFill>
  );
};

/* ── 9 + 10. name card, then the close ───────────────────────────── */

const NameScene: React.FC = () => {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [0, 20, 50, 60], [0, 0.55, 0.75, 0.75], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK, alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontFamily: FONT_SANS, fontSize: 40, color: `rgba(255,255,255,${o})` }}>
        Pelosi Tracker
      </div>
    </AbsoluteFill>
  );
};

const NOW_TEXT = "Now on Autopilot";

const NowScene: React.FC = () => {
  const frame = useCurrentFrame();
  const chars = Math.floor(
    interpolate(frame, [2, 22], [0, NOW_TEXT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const cursorOn = frame % 16 < 10;
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK, alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30 }}>
        <div style={{ fontFamily: FONT_SANS, fontWeight: 500, fontSize: 54, color: "#f2f2f2" }}>
          {NOW_TEXT.slice(0, chars)}
          <span style={{ opacity: cursorOn ? 1 : 0 }}>▎</span>
        </div>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 22,
            letterSpacing: "0.2em",
            backgroundImage: PEARL_GRAD,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            opacity: interpolate(frame, [18, 28], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          AUTOPILOTSOL.VERCEL.APP
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ── assembly ────────────────────────────────────────────────────── */

export const Launch: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK }}>
      <Audio src={staticFile("launch-track.m4a")} />
      <Sequence from={TWEET.from} durationInFrames={TWEET.dur}>
        <TweetScene />
      </Sequence>
      <Sequence from={WALL.from} durationInFrames={WALL.dur}>
        <WallScene />
      </Sequence>
      <Sequence from={MACRO.from} durationInFrames={MACRO.dur} premountFor={30}>
        <Footage src="clips/macro.mp4" caption="Introducing" rate={0.92} />
      </Sequence>
      <Sequence from={NOTIF.from} durationInFrames={NOTIF.dur}>
        <NotifScene />
      </Sequence>
      <Sequence from={STUDIO1.from} durationInFrames={STUDIO1.dur}>
        <Studio1 />
      </Sequence>
      <Sequence from={TUNNEL.from} durationInFrames={TUNNEL.dur} premountFor={30}>
        <Footage src="clips/tunnel.mp4" caption="Where filings become tokens" />
      </Sequence>
      <Sequence from={RESULT.from} durationInFrames={RESULT.dur}>
        <ResultScene />
      </Sequence>
      <Sequence from={STUDIO2.from} durationInFrames={STUDIO2.dur} premountFor={30}>
        <Studio2 />
      </Sequence>
      <Sequence from={NAME.from} durationInFrames={NAME.dur}>
        <NameScene />
      </Sequence>
      <Sequence from={NOW.from} durationInFrames={NOW.dur}>
        <NowScene />
      </Sequence>
    </AbsoluteFill>
  );
};
