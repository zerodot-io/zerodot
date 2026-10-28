// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";
import { AuthForm } from "../components/auth-form";

export const Route = createFileRoute("/sign-in")({
  component: () => <AuthForm mode="sign-in" />,
});
