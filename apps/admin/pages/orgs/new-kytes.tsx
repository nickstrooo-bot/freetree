import Head from "next/head";
import { NewKytesScreen } from "../../components/screens/orgs/new-kytes-screen";

export function NewKytes() {
  return (
    <>
      <Head>
        <title>New kytes — FreeTree admin</title>
      </Head>
      <NewKytesScreen />
    </>
  );
}

export default NewKytes;
