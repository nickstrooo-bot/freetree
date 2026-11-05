import Head from "next/head";
import { ModerationPatternsScreen } from "../../components/screens/moderation/moderation-patterns-screen";

export function ModerationPatterns() {
  return (
    <>
      <Head>
        <title>Moderation patterns — FreeTree admin</title>
      </Head>
      <ModerationPatternsScreen />
    </>
  );
}

export default ModerationPatterns;
