import Head from "next/head";
import { ReviewModeScreen } from "../../components/screens/moderation/review-mode-screen";

export function ModerationReview() {
  return (
    <>
      <Head>
        <title>Review mode — FreeTree admin</title>
      </Head>
      <ReviewModeScreen />
    </>
  );
}

export default ModerationReview;
