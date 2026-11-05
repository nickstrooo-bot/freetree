import Head from "next/head";
import { ModerationAppealsScreen } from "../../components/screens/moderation/moderation-appeals-screen";

export function ModerationAppeals() {
  return (
    <>
      <Head>
        <title>Appeals — FreeTree admin</title>
      </Head>
      <ModerationAppealsScreen />
    </>
  );
}

export default ModerationAppeals;
