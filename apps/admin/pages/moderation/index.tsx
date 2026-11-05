import Head from "next/head";
import { ModerationQueueScreen } from "../../components/screens/moderation/moderation-queue-screen";

export function Moderation() {
  return (
    <>
      <Head>
        <title>Moderation queue — FreeTree admin</title>
      </Head>
      <ModerationQueueScreen />
    </>
  );
}

export default Moderation;
