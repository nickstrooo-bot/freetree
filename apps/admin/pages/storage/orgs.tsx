import Head from "next/head";
import { StorageOrgsScreen } from "../../components/screens/storage/storage-orgs-screen";

export function StorageOrgs() {
  return (
    <>
      <Head>
        <title>Storage by org — FreeTree admin</title>
      </Head>
      <StorageOrgsScreen />
    </>
  );
}

export default StorageOrgs;
