import { Composition } from "remotion";
import { Promo, PROMO_DURATION } from "./Promo";
import { Viral, VIRAL_DURATION } from "./Viral";
import { Launch, LAUNCH_DURATION } from "./Launch";
import { Tease, TEASE_DURATION } from "./Tease";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Promo"
        component={Promo}
        durationInFrames={PROMO_DURATION}
        fps={30}
        width={1080}
        height={1080}
      />
      <Composition
        id="Viral"
        component={Viral}
        durationInFrames={VIRAL_DURATION}
        fps={30}
        width={1080}
        height={1080}
      />
      <Composition
        id="Launch"
        component={Launch}
        durationInFrames={LAUNCH_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="Tease"
        component={Tease}
        durationInFrames={TEASE_DURATION}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
