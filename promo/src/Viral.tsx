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
  FONT_SERIF,
  INK,
  MUTED,
  PAPER,
  PEARL_A,
  PEARL_C,
  PEARL_GRAD,
  POS,
  RULE,
} from "./theme";

/*
 * "Do you have a job?" meme cut — neetguy formula:
 * film dialogue audio carries the hook, brand slams carry the payoff.
 * All timings are locked to the source edit's shot boundaries.
 */

const sec = (s: number) => Math.round(s * 30);

// Dialogue beats (from scene-cut detection on the source).
const Q1 = { from: sec(0.9), dur: sec(4.34) - sec(0.9) };
const A1 = { from: sec(4.34), dur: sec(6.46) - sec(4.34) };
const Q2 = { from: sec(6.46), dur: sec(7.84) - sec(6.46) };
const A2 = { from: sec(7.84), dur: sec(9.8) - sec(7.84) };
const Q3 = { from: sec(9.8), dur: sec(13.1) - sec(9.8) };
const PUNCH = { from: sec(13.1), dur: sec(16.89) - sec(13.1) };
// Payoff beats, on the source's slam cuts.
const SLAM1 = { from: sec(16.89), dur: sec(19.35) - sec(16.89) };
const CLIP1 = { from: sec(19.35), dur: sec(23.86) - sec(19.35) };
const SLAM2 = { from: sec(23.86), dur: sec(25.15) - sec(23.86) };
const CLIP2 = { from: sec(25.15), dur: sec(27.03) - sec(25.15) };
const SLAM3 = { from: sec(27.03), dur: sec(28.24) - sec(27.03) };
const CLIP3 = { from: sec(28.24), dur: sec(29.9) - sec(28.24) };
const OUTRO = { from: sec(29.9), dur: sec(35.09) - sec(29.9) };
export const VIRAL_DURATION = OUTRO.from + OUTRO.dur;

/* ── shared bits ─────────────────────────────────────────────────── */

const Paper: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: PAPER,
      backgroundImage: [
        "radial-gradient(circle at 1px 1px, rgb(10 10 10 / 0.07) 1px, transparent 0)",
        "radial-gradient(46% 40% at 12% 6%, rgb(0 255 163 / 0.16), transparent 70%)",
        "radial-gradient(50% 44% at 86% 2%, rgb(220 31 255 / 0.14), transparent 72%)",
        "radial-gradient(64% 52% at 92% 66%, rgb(220 31 255 / 0.10), transparent 74%)",
      ].join(","),
      backgroundSize: "24px 24px, auto, auto, auto",
    }}
  >
    {children}
  </AbsoluteFill>
);

const useRise = (delay: number, distance = 40) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return {
    opacity: s,
    transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)`,
  };
};

/* ── dialogue cards (black, cinematic, subtitle energy) ──────────── */

const QCard: React.FC<{ text: string; sub?: string }> = ({ text, sub }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const rise = useRise(2, 30);
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.06]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0c" }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${drift})`,
          flexDirection: "column",
          gap: 30,
          padding: 90,
        }}
      >
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 108,
            lineHeight: 1.08,
            color: PAPER,
            textAlign: "center",
            ...rise,
          }}
        >
          {text}
        </div>
        {sub ? (
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 20,
              letterSpacing: "0.24em",
              color: "rgba(250,250,248,0.45)",
            }}
          >
            {sub}
          </div>
        ) : null}
      </AbsoluteFill>
      {/* vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(70% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

const ACard: React.FC<{ text?: string }> = ({ text = "no." }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const pop = spring({ frame: frame - 1, fps, config: { damping: 200 } });
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.08]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0c" }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${drift})`,
        }}
      >
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 190,
            backgroundImage: PEARL_GRAD,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            opacity: pop,
            transform: `scale(${interpolate(pop, [0, 1], [1.6, 1])})`,
          }}
        >
          {text}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ── the punchline: paper flip ───────────────────────────────────── */

const PunchlineCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = useRise(4, 40);
  const coin = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  const tilt = Math.sin(frame * 0.09) * 16;
  return (
    <Paper>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 54,
        }}
      >
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 112,
            lineHeight: 1.08,
            color: INK,
            textAlign: "center",
            ...line,
          }}
        >
          pelosi trades
          <br />
          for me.
        </div>
        <div
          style={{
            width: 220,
            height: 220,
            opacity: coin,
            transform: `scale(${interpolate(coin, [0, 1], [0.4, 1])}) perspective(1200px) rotateY(${tilt}deg)`,
          }}
        >
          <Img
            src={staticFile("tokens/pltsol.png")}
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      </AbsoluteFill>
    </Paper>
  );
};

/* ── slam cards (the NEET-globe move, in brand) ──────────────────── */

const SlamCard: React.FC<{
  kind: "logo" | "stat" | "tagline";
}> = ({ kind }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slam = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 14 });
  const scale = interpolate(slam, [0, 1], [2.6, 1]);
  const shake = frame < 8 ? Math.sin(frame * 3.1) * (8 - frame) : 0;
  // Pearl echo copies in place of RGB chromatic glitch.
  const echo = interpolate(slam, [0, 1], [26, 0]);
  const content =
    kind === "logo" ? (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
        <div style={{ width: 300, height: 300 }}>
          <Img src={staticFile("tokens/pltsol.png")} style={{ width: "100%", height: "100%" }} />
        </div>
        <div style={{ fontFamily: FONT_SERIF, fontSize: 120, color: INK }}>Autopilot.</div>
      </div>
    ) : kind === "stat" ? (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <div style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 200, color: POS }}>
          +154%
        </div>
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 58,
            color: INK,
          }}
        >
          her book, one year, backtested.
        </div>
      </div>
    ) : (
      <div
        style={{
          fontFamily: FONT_SERIF,
          fontSize: 118,
          lineHeight: 1.08,
          color: INK,
          textAlign: "center",
        }}
      >
        Trade the trader,
        <br />
        <span style={{ fontStyle: "italic" }}>not the market.</span>
      </div>
    );
  return (
    <Paper>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        {/* pearl echoes behind the slam */}
        <div
          style={{
            position: "absolute",
            opacity: 0.5,
            filter: "blur(2px)",
            transform: `scale(${scale}) translate(${-echo}px, ${echo * 0.6}px)`,
            color: PEARL_A,
          }}
        >
          {content}
        </div>
        <div
          style={{
            position: "absolute",
            opacity: 0.5,
            filter: "blur(2px)",
            transform: `scale(${scale}) translate(${echo}px, ${-echo * 0.6}px)`,
            color: PEARL_C,
          }}
        >
          {content}
        </div>
        <div style={{ transform: `scale(${scale}) translateX(${shake}px)` }}>{content}</div>
      </AbsoluteFill>
    </Paper>
  );
};

/* ── quick product clips between slams ───────────────────────────── */

const QuickClip: React.FC<{
  src: string;
  origin: string;
  startFrom?: number;
  caption: string;
}> = ({ src, origin, startFrom = 0, caption }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const zoom = interpolate(frame, [0, durationInFrames], [1.05, 1.35], {
    extrapolateRight: "clamp",
  });
  const cap = useRise(6, 24);
  return (
    <Paper>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 34 }}>
        <div
          style={{
            width: 940,
            borderRadius: 22,
            border: `1px solid ${RULE}`,
            overflow: "hidden",
            backgroundColor: "#fff",
            boxShadow: "0 30px 80px rgba(10,10,10,0.18)",
            opacity: enter,
            transform: `translateY(${interpolate(enter, [0, 1], [50, 0])}px)`,
          }}
        >
          <OffthreadVideo
            src={staticFile(src)}
            startFrom={startFrom}
            playbackRate={1.3}
            muted
            style={{
              width: "100%",
              display: "block",
              transform: `scale(${zoom})`,
              transformOrigin: origin,
            }}
          />
        </div>
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 52,
            color: INK,
            ...cap,
          }}
        >
          {caption}
        </div>
      </AbsoluteFill>
    </Paper>
  );
};

/* ── outro ───────────────────────────────────────────────────────── */

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const logo = useRise(0, 36);
  const chip = useRise(10, 24);
  const pulse = 1 + Math.sin(frame * 0.16) * 0.03;
  return (
    <Paper>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 44 }}>
        <div style={{ width: 190, height: 190, transform: `perspective(1100px) rotateY(${Math.sin(frame * 0.08) * 18}deg)` }}>
          <Img src={staticFile("tokens/pltsol.png")} style={{ width: "100%", height: "100%" }} />
        </div>
        <div style={{ fontFamily: FONT_SERIF, fontSize: 150, color: INK, ...logo }}>
          Autopilot.
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, ...chip }}>
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
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 19,
              letterSpacing: "0.22em",
              color: FAINT,
            }}
          >
            LIVE ON DEVNET · MAINNET SOON
          </div>
        </div>
      </AbsoluteFill>
    </Paper>
  );
};

/* ── assembly ────────────────────────────────────────────────────── */

export const Viral: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0c" }}>
      <Audio src={staticFile("viral-track.m4a")} />
      <Sequence from={0} durationInFrames={Q1.from + Q1.dur}>
        <QCard text="do you have a job?" sub="TURN SOUND ON" />
      </Sequence>
      <Sequence from={A1.from} durationInFrames={A1.dur}>
        <ACard />
      </Sequence>
      <Sequence from={Q2.from} durationInFrames={Q2.dur}>
        <QCard text="do you make money?" />
      </Sequence>
      <Sequence from={A2.from} durationInFrames={A2.dur}>
        <ACard />
      </Sequence>
      <Sequence from={Q3.from} durationInFrames={Q3.dur}>
        <QCard text="how do you live?" />
      </Sequence>
      <Sequence from={PUNCH.from} durationInFrames={PUNCH.dur}>
        <PunchlineCard />
      </Sequence>
      <Sequence from={SLAM1.from} durationInFrames={SLAM1.dur}>
        <SlamCard kind="logo" />
      </Sequence>
      <Sequence from={CLIP1.from} durationInFrames={CLIP1.dur} premountFor={30}>
        <QuickClip
          src="clips/buy.mp4"
          origin="29% 55%"
          startFrom={45}
          caption="deposit SOL, hold her book."
        />
      </Sequence>
      <Sequence from={SLAM2.from} durationInFrames={SLAM2.dur}>
        <SlamCard kind="stat" />
      </Sequence>
      <Sequence from={CLIP2.from} durationInFrames={CLIP2.dur} premountFor={30}>
        <QuickClip
          src="clips/vault.mp4"
          origin="35% 35%"
          caption="every vault, live."
        />
      </Sequence>
      <Sequence from={SLAM3.from} durationInFrames={SLAM3.dur}>
        <SlamCard kind="tagline" />
      </Sequence>
      <Sequence from={CLIP3.from} durationInFrames={CLIP3.dur} premountFor={30}>
        <QuickClip
          src="clips/receipt.mp4"
          origin="40% 45%"
          startFrom={110}
          caption="the chain is the receipt."
        />
      </Sequence>
      <Sequence from={OUTRO.from} durationInFrames={OUTRO.dur}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
