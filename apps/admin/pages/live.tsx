import Head from "next/head";
import { LiveScreen } from "../components/screens/live/live-screen";

export function Live() {
  return (
    <>
      <Head>
        <title>Live — FreeTree admin</title>
      </Head>
      <LiveScreen />
    </>
  );
}

export default Live;
