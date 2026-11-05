import { PageHead } from "../components/seo/page-head";
import { AuthScreen } from "../components/screens/auth/auth-screen";

export function LoginPage() {
  return (
    <>
      <PageHead
        title="Log in | FreeTree"
        description="Log in to FreeTree to edit your kyte, links, and analytics."
        canonicalPath="/login"
      />
      <AuthScreen mode="login" />
    </>
  );
}

export default LoginPage;
