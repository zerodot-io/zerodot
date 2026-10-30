// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "../components/auth-form";
import { getSignupOpenFn } from "../server/fns";

export const Route = createFileRoute("/sign-in")({
  head: () => ({ meta: [{ title: "Sign in · zerodot" }] }),
  loader: () => getSignupOpenFn(),
  component: SignIn,
});

function SignIn() {
  const signupOpen = Route.useLoaderData();
  return <AuthForm mode="sign-in" signupOpen={signupOpen} />;
}
