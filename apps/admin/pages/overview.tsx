import Head from "next/head";
import { OverviewScreen } from "../components/screens/overview/overview-screen";

export function Overview() {
  return (
    <>
      <Head>
        <title>Overview — FreeTree admin</title>
      </Head>
      <OverviewScreen />
    </>
  );
}

export default Overview;
