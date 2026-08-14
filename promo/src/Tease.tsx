import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_MONO, FONT_SANS, FONT_SERIF, PEARL_GRAD, POS } from "./theme";

/*
 * The tease, v2 — typed-tweet hook, raining pltSOL comments, a live
 * rebalance sequence on the real pltSOL basket, then the airdrop wink.
 * Cut to the launch track's scene rhythm. Nothing is confirmed.
 */

const sec = (s: number) => Math.round(s * 30);

const HOOK = { from: 0, dur: sec(3.33) };
const FOLLOW = { from: sec(3.33), dur: sec(6.63) - sec(3.33) };
const COMMENT = { from: sec(6.63), dur: sec(10.5) - sec(6.63) };
const REBALANCE = { from: sec(10.5), dur: sec(14.9) - sec(10.5) };
const EXCHANGE = { from: sec(14.9), dur: sec(18.0) - sec(14.9) };
const TEASE = { from: sec(18.0), dur: sec(22.0) - sec(18.0) };
const HOLD = { from: sec(22.0), dur: sec(24.0) - sec(22.0) };
const NOW = { from: sec(24.0), dur: sec(25.05) - sec(24.0) };
export const TEASE_DURATION = NOW.from + NOW.dur;

const BLACK = "#050506";

/* ── shared bits ─────────────────────────────────────────────────── */

const useRise = (delay: number, distance = 40) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return {
    opacity: s,
    transform: `translateY(${interpolate(s, [0, 1], [distance, 0])}px)`,
  };
};

const Dark: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const drift = interpolate(frame, [0, durationInFrames], [1, 1.06]);
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(42% 32% at 14% 8%, rgba(159,239,205,0.08), transparent 70%)," +
            "radial-gradient(42% 32% at 88% 92%, rgba(246,185,223,0.08), transparent 70%)",
        }}
      />
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", transform: `scale(${drift})` }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

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

const Check: React.FC<{ size?: number }> = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
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
);

/* ── 1. hook: our tweet, typed live ──────────────────────────────── */

const HOOK_TEXT = "pltSOL holders… stay very close this week 🪂";

const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const chars = Math.floor(
    interpolate(frame, [8, 78], [0, HOOK_TEXT.length], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );
  const cursorOn = frame % 18 < 11;
  return (
    <Dark>
      <div
        style={{
          width: 880,
          borderRadius: 22,
          backgroundColor: "#111214",
          border: "1px solid #222428",
          padding: "34px 38px",
          boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <Img
            src={staticFile("cat-night.png")}
            style={{ width: 64, height: 64, borderRadius: 64 }}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 28, color: "#e7e9ea" }}>
                Autopilot Solana
              </span>
              <Check size={24} />
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
            fontSize: 36,
            lineHeight: 1.35,
            color: "#e7e9ea",
            minHeight: 100,
          }}
        >
          {HOOK_TEXT.slice(0, chars)}
          <span style={{ opacity: cursorOn ? 1 : 0 }}>▎</span>
        </div>
      </div>
    </Dark>
  );
};

/* ── 2. follow card ──────────────────────────────────────────────── */

const FollowScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = useRise(0, 50);
  const CLICK = 50; // absolute frame 150 = 5.0s, synced with the bell
  const pressed = frame >= CLICK;
  const press = spring({ frame: frame - CLICK, fps, config: { damping: 200 } });
  const scale = pressed ? interpolate(press, [0, 0.4, 1], [0.92, 1.04, 1]) : 1;
  const bob = Math.sin(frame * 0.07) * 5;
  return (
    <Dark>
      <div
        style={{
          width: 880,
          borderRadius: 22,
          backgroundColor: "#111214",
          border: "1px solid #222428",
          padding: "38px 42px",
          display: "flex",
          alignItems: "center",
          gap: 22,
          boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
          ...card,
          transform: `${card.transform} translateY(${bob}px)`,
        }}
      >
        <Img
          src={staticFile("cat-night.png")}
          style={{ width: 96, height: 96, borderRadius: 96 }}
        />
        <div style={{ flexGrow: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 32, color: "#e7e9ea" }}>
              Autopilot Solana
            </span>
            <Check />
          </div>
          <div style={{ fontFamily: FONT_SANS, fontSize: 24, color: "#71767b" }}>@AutopilotxSOL</div>
        </div>
        <div
          style={{
            padding: "16px 36px",
            borderRadius: 999,
            fontFamily: FONT_SANS,
            fontWeight: 700,
            fontSize: 26,
            transform: `scale(${scale})`,
            backgroundColor: pressed ? "transparent" : "#eff3f4",
            color: pressed ? "#e7e9ea" : "#0f1419",
            border: pressed ? "1px solid #536471" : "1px solid transparent",
          }}
        >
          {pressed ? "Following" : "Follow"}
        </div>
      </div>
      <Caption text="Step one" />
    </Dark>
  );
};

/* ── 3. comment pltSOL — replies raining ─────────────────────────── */

// `pfp` is optional: an https URL or a file in promo/public (e.g. "pfps/toly.jpg").
// When set it replaces the gradient circle. Drop real avatars in only for accounts
// that actually replied.
type Reply = {
  name: string;
  handle: string;
  text: string;
  hue: number;
  pfp?: string;
  check?: boolean;
};

// Real accounts appear only with things they actually tweeted, verbatim
// (fetched 2026-08-15). The pltSOL spam comes from the parody accounts;
// the legends are just the timeline going about its day.
const REPLIES: Reply[] = [
  { name: "gm enjoyer", handle: "@gmdotintern", text: "pltSOL", hue: 150 },
  {
    name: "toly 🇺🇸",
    handle: "@toly",
    pfp: "https://pbs.twimg.com/profile_images/2075257710715781123/74AtQPd6_400x400.jpg",
    text: "10k TPS all day every day would be cool",
    hue: 240,
    check: true,
  },
  { name: "she files i buy", handle: "@disclosuredegen", text: "pltSOL 😼", hue: 320 },
  {
    name: "chase",
    handle: "@therealchaseeb",
    pfp: "https://pbs.twimg.com/profile_images/2084847775296978944/xb6t_fy7_400x400.jpg",
    text: "I hear dinosaurs on solana.",
    hue: 200,
    check: true,
  },
  { name: "validator wife", handle: "@stakewifey", text: "pltSOL 🪂🪂", hue: 180 },
  {
    name: "vibhu",
    handle: "@vibhu",
    pfp: "https://pbs.twimg.com/profile_images/2061115398854995970/NlohW-pV_400x400.jpg",
    text: "Do you play backgammon?",
    hue: 40,
    check: true,
  },
  { name: "unemployed, up bad", handle: "@exitliquidity", text: "pltSOL pltSOL pltSOL", hue: 270 },
  {
    name: "Jakey",
    handle: "@SolJakey",
    pfp: "https://pbs.twimg.com/profile_images/2054466150948622336/EP1yjB-6_400x400.jpg",
    text: "SOLANA SUMMER",
    hue: 120,
    check: true,
  },
];

const Avatar: React.FC<{ pfp?: string; hue: number; size: number }> = ({ pfp, hue, size }) => {
  if (pfp) {
    return (
      <Img
        src={pfp.startsWith("http") ? pfp : staticFile(pfp)}
        style={{
          width: size,
          height: size,
          borderRadius: size,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: `linear-gradient(135deg, hsl(${hue} 70% 75%), hsl(${hue + 60} 70% 70%))`,
        flexShrink: 0,
      }}
    />
  );
};

const CommentScene: React.FC = () => {
  return (
    <Dark>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 860 }}>
        {REPLIES.map((r, i) => (
          <ReplyChip key={r.handle} {...r} delay={2 + i * 6} index={i} />
        ))}
      </div>
      <Caption text="Step two. Comment pltSOL" />
    </Dark>
  );
};

const ReplyChip: React.FC<Reply & { delay: number; index: number }> = ({
  name,
  handle,
  text,
  hue,
  pfp,
  check,
  delay,
  index,
}) => {
  const frame = useCurrentFrame();
  const rise = useRise(delay, 46);
  const bob = Math.sin(frame * 0.08 + index * 1.7) * 4;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 15,
        padding: "12px 20px",
        borderRadius: 18,
        backgroundColor: "#111214",
        border: "1px solid #222428",
        marginLeft: index % 2 === 0 ? 0 : 80,
        marginRight: index % 2 === 0 ? 80 : 0,
        ...rise,
        transform: `${rise.transform} translateY(${bob}px)`,
      }}
    >
      <Avatar pfp={pfp} hue={hue} size={46} />
      <div style={{ flexGrow: 1 }}>
        <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 21, color: "#e7e9ea" }}>
          {name}
        </span>
        {check ? (
          <span style={{ display: "inline-block", verticalAlign: "-3px", marginLeft: 6 }}>
            <Check size={18} />
          </span>
        ) : null}
        <span style={{ fontFamily: FONT_SANS, fontSize: 19, color: "#71767b", marginLeft: 9 }}>
          {handle}
        </span>
        <div style={{ fontFamily: FONT_SANS, fontSize: 23, color: "#e7e9ea", marginTop: 2 }}>
          {text}
        </div>
      </div>
    </div>
  );
};

/* ── 4. the rebalance: her filing lands, the basket moves ────────── */

// Real pltSOL basket, then the post-filing targets it animates toward.
const LEGS = [
  { sym: "INTCx", name: "Intel", from: 48, to: 36, px: 98.14, dir: 1 },
  { sym: "NVDAx", name: "NVIDIA", from: 6, to: 18, px: 218.98, dir: 1 },
  { sym: "UBERx", name: "Uber", from: 12, to: 12, px: 78.02, dir: -1 },
  { sym: "AMZNx", name: "Amazon", from: 12, to: 10, px: 272.54, dir: -1 },
  { sym: "GOOGLx", name: "Alphabet", from: 12, to: 14, px: 346.16, dir: 1 },
  { sym: "AAPLx", name: "Apple", from: 6, to: 6, px: 304.85, dir: -1 },
];

const SHIFT_AT = 52; // weights start sliding here

const RebalanceScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const panel = useRise(0, 50);
  const alertIn = spring({ frame: frame - 10, fps, config: { damping: 200 } });
  const alertPulse = 1 + Math.sin(frame * 0.25) * 0.02;
  return (
    <Dark>
      <div
        style={{
          width: 900,
          borderRadius: 22,
          backgroundColor: "#0d0e11",
          border: "1px solid #222428",
          padding: "30px 34px",
          boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
          ...panel,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <div
            style={{
              padding: "10px 20px",
              borderRadius: 999,
              backgroundImage: PEARL_GRAD,
              color: "#16161c",
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: "0.14em",
              opacity: alertIn,
              transform: `scale(${interpolate(alertIn, [0, 1], [0.7, 1]) * alertPulse})`,
            }}
          >
            NEW FILING DETECTED
          </div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 18,
              letterSpacing: "0.14em",
              color: frame > SHIFT_AT ? "#35d9a0" : "#71767b",
            }}
          >
            {frame > SHIFT_AT ? "● REBALANCING" : "○ READING…"}
          </div>
          <div
            style={{
              marginLeft: "auto",
              fontFamily: FONT_MONO,
              fontSize: 17,
              color: "#71767b",
            }}
          >
            pltSOL · NAV 1.0000
          </div>
        </div>
        {LEGS.map((l, i) => (
          <LegRow key={l.sym} {...l} index={i} />
        ))}
      </div>
      <Caption text="She files. The basket follows. Automatically." delay={16} />
    </Dark>
  );
};

const LegRow: React.FC<{
  sym: string;
  name: string;
  from: number;
  to: number;
  px: number;
  dir: number;
  index: number;
}> = ({ sym, name, from, to, px, dir, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = useRise(4 + index * 5, 26);
  const shift = spring({
    frame: frame - (SHIFT_AT + index * 6),
    fps,
    config: { damping: 200 },
  });
  const w = interpolate(shift, [0, 1], [from, to]);
  const changed = from !== to;
  const moved = frame > SHIFT_AT + index * 6 + 8 && changed;
  // Prices tick with a little deterministic jitter.
  const tick = Math.sin(frame * 0.31 + index * 2.3) * 0.12 + Math.sin(frame * 0.09 + index) * 0.2;
  const price = (px + tick * dir).toFixed(2);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "13px 0",
        borderTop: index === 0 ? "none" : "1px solid #1b1d21",
        ...rise,
      }}
    >
      <div style={{ width: 108, fontFamily: FONT_MONO, fontWeight: 700, fontSize: 23, color: "#e7e9ea" }}>
        {sym}
      </div>
      <div style={{ width: 120, fontFamily: FONT_SANS, fontSize: 20, color: "#71767b" }}>{name}</div>
      <div style={{ flexGrow: 1, height: 14, borderRadius: 7, backgroundColor: "#1b1d21", overflow: "hidden" }}>
        <div
          style={{
            width: `${w * 2}%`,
            height: "100%",
            borderRadius: 7,
            backgroundImage: moved
              ? "linear-gradient(90deg, #35d9a0, #7f9bef)"
              : PEARL_GRAD,
            opacity: moved ? 1 : 0.65,
          }}
        />
      </div>
      <div
        style={{
          width: 92,
          textAlign: "right",
          fontFamily: FONT_MONO,
          fontWeight: 700,
          fontSize: 22,
          color: moved ? "#35d9a0" : "#e7e9ea",
        }}
      >
        {w.toFixed(1)}%
      </div>
      <div style={{ width: 118, textAlign: "right", fontFamily: FONT_MONO, fontSize: 19, color: "#9a9ba1" }}>
        ${price}
      </div>
    </div>
  );
};

/* ── 5. the exchange: comment → our reply ────────────────────────── */

const ExchangeScene: React.FC = () => {
  const top = useRise(2, 40);
  const reply = useRise(30, 60);
  return (
    <Dark>
      <div style={{ display: "flex", flexDirection: "column", gap: 0, width: 900 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            padding: "22px 28px",
            borderRadius: 20,
            backgroundColor: "#111214",
            border: "1px solid #222428",
            ...top,
          }}
        >
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 60,
              background: "linear-gradient(135deg, hsl(240 70% 75%), hsl(300 70% 70%))",
              flexShrink: 0,
            }}
          />
          <div>
            <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 25, color: "#e7e9ea" }}>
              orb watcher
            </span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 22, color: "#71767b", marginLeft: 10 }}>
              @copytrooper
            </span>
            <div style={{ fontFamily: FONT_SANS, fontSize: 32, color: "#e7e9ea", marginTop: 4 }}>
              pltSOL
            </div>
          </div>
        </div>
        <div style={{ width: 3, height: 32, backgroundColor: "#2a2c31", marginLeft: 58 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            padding: "26px 30px",
            borderRadius: 20,
            backgroundColor: "#15161a",
            border: "1px solid #2c2e33",
            boxShadow: "0 30px 90px rgba(0,0,0,0.6)",
            ...reply,
          }}
        >
          <Img
            src={staticFile("cat-night.png")}
            style={{ width: 72, height: 72, borderRadius: 72, flexShrink: 0 }}
          />
          <div>
            <span style={{ fontFamily: FONT_SANS, fontWeight: 600, fontSize: 27, color: "#e7e9ea" }}>
              Autopilot Solana
            </span>
            <span style={{ display: "inline-block", verticalAlign: "-4px", marginLeft: 8 }}>
              <Check size={24} />
            </span>
            <span style={{ fontFamily: FONT_SANS, fontSize: 22, color: "#71767b", marginLeft: 10 }}>
              @AutopilotxSOL
            </span>
            <div style={{ fontFamily: FONT_SANS, fontSize: 38, color: "#e7e9ea", marginTop: 8 }}>
              good news is on the way 🪂
            </div>
          </div>
        </div>
      </div>
      <Caption text="We reply to every single one" delay={48} />
    </Dark>
  );
};

/* ── 6. the non-confirmation ─────────────────────────────────────── */

const TeaseScene: React.FC = () => {
  const frame = useCurrentFrame();
  const chute = useRise(2, 70);
  const l1 = useRise(12);
  const sway = Math.sin(frame * 0.07) * 9;
  const fall = interpolate(frame, [0, 120], [0, 34]);
  return (
    <Dark>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30 }}>
        <div
          style={{
            fontSize: 190,
            ...chute,
            transform: `${chute.transform} translateY(${fall}px) rotate(${sway}deg)`,
          }}
        >
          🪂
        </div>
        <div
          style={{
            fontFamily: FONT_SANS,
            fontWeight: 800,
            fontSize: 84,
            letterSpacing: "-0.02em",
            color: "#f2f2f2",
            textAlign: "center",
            ...l1,
          }}
        >
          AIRDROP? WE SAID{" "}
          <span
            style={{
              backgroundImage: PEARL_GRAD,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            NOTHING.
          </span>
        </div>
      </div>
      <Caption text="Absolutely nothing was confirmed today" delay={20} />
    </Dark>
  );
};

/* ── 7. hold pltSOL ──────────────────────────────────────────────── */

const HoldScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slam = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 14 });
  const scale = interpolate(slam, [0, 1], [2.2, 1]);
  const tilt = Math.sin(frame * 0.08) * 14;
  const l = useRise(14);
  return (
    <Dark>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 40 }}>
        <div
          style={{
            width: 300,
            height: 300,
            transform: `scale(${scale}) perspective(1200px) rotateY(${tilt}deg)`,
          }}
        >
          <Img src={staticFile("tokens/pltsol.png")} style={{ width: "100%", height: "100%" }} />
        </div>
        <div
          style={{
            fontFamily: FONT_SERIF,
            fontStyle: "italic",
            fontSize: 74,
            color: "#f2f2f2",
            ...l,
          }}
        >
          hold pltSOL. stay close.
        </div>
      </div>
    </Dark>
  );
};

/* ── 8. close ────────────────────────────────────────────────────── */

const NOW_TEXT = "Follow. Comment. 🪂";

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
    <Dark>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30 }}>
        <div style={{ fontFamily: FONT_SANS, fontWeight: 500, fontSize: 56, color: "#f2f2f2" }}>
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
            opacity: interpolate(frame, [16, 26], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          @AUTOPILOTXSOL · AUTOPILOTSOL.VERCEL.APP
        </div>
      </div>
    </Dark>
  );
};

/* ── assembly ────────────────────────────────────────────────────── */

export const Tease: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: BLACK }}>
      <Audio src={staticFile("launch-track.m4a")} />
      {/* Bell lands exactly at 5.0s, on the Follow press. */}
      <Sequence from={150} layout="none">
        <Audio src={staticFile("sfx/ding.m4a")} volume={1} />
      </Sequence>
      <Sequence from={HOOK.from} durationInFrames={HOOK.dur}>
        <HookScene />
      </Sequence>
      <Sequence from={FOLLOW.from} durationInFrames={FOLLOW.dur}>
        <FollowScene />
      </Sequence>
      <Sequence from={COMMENT.from} durationInFrames={COMMENT.dur}>
        <CommentScene />
      </Sequence>
      <Sequence from={REBALANCE.from} durationInFrames={REBALANCE.dur}>
        <RebalanceScene />
      </Sequence>
      <Sequence from={EXCHANGE.from} durationInFrames={EXCHANGE.dur}>
        <ExchangeScene />
      </Sequence>
      <Sequence from={TEASE.from} durationInFrames={TEASE.dur}>
        <TeaseScene />
      </Sequence>
      <Sequence from={HOLD.from} durationInFrames={HOLD.dur}>
        <HoldScene />
      </Sequence>
      <Sequence from={NOW.from} durationInFrames={NOW.dur}>
        <NowScene />
      </Sequence>
    </AbsoluteFill>
  );
};
