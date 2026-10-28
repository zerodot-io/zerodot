// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "../components/auth-form";

export const Route = createFileRoute("/sign-up")({
  head: () => ({ meta: [{ title: "Sign up · zerodot" }] }),
  component: () => <AuthForm mode="sign-up" />,
});
