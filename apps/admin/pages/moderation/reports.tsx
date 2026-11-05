import Head from "next/head";
import { ModerationReportsScreen } from "../../components/screens/moderation/moderation-reports-screen";

export function ModerationReports() {
  return (
    <>
      <Head>
        <title>Abuse reports — FreeTree admin</title>
      </Head>
      <ModerationReportsScreen />
    </>
  );
}

export default ModerationReports;
