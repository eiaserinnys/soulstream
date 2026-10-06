import { SwayCharacter } from "@seosoyoung/soul-ui";

export function SwayCharacterReviewSample() {
  return <div className="v3-components-samples">
    <SwayCharacter
      width={184}
      height={276}
      shown
      motionEnabled
      active
      assetBaseUrl="/characters/seosoyoung"
    />
    <SwayCharacter
      width={184}
      height={276}
      shown
      motionEnabled={false}
      active
      assetBaseUrl="/characters/seosoyoung"
    />
    <SwayCharacter
      width={184}
      height={276}
      shown={false}
      motionEnabled
      active
      assetBaseUrl="/characters/seosoyoung"
    />
  </div>;
}
