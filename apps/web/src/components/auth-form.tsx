// SPDX-License-Identifier: AGPL-3.0-only

import { FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@zerodot/auth/client";
import { Button, Card, Field, FieldGroup, FieldLabel, Input, Logo } from "@zerodot/ui";
import { type FormEvent, useEffect, useState } from "react";

export function AuthForm({
  mode,
  signupOpen = true,
}: {
  mode: "sign-in" | "sign-up";
  /** False hides the sign-up link on the sign-in page. */
  signupOpen?: boolean;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  // Passkey autofill: the browser offers saved passkeys in the email field.
  useEffect(() => {
    if (isSignUp || typeof PublicKeyCredential === "undefined") return;
    let active = true;
    void (async () => {
      if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
      const result = await authClient.signIn.passkey({ autoFill: true });
      if (active && !result.error) await navigate({ to: "/" });
    })();
    return () => {
      active = false;
    };
  }, [isSignUp, navigate]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const result = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
      : await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Something went wrong");
      return;
    }
    await navigate({ to: "/" });
  }

  async function onPasskey() {
    setError(null);
    setPending(true);
    const result = await authClient.signIn.passkey();
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Passkey sign-in failed");
      return;
    }
    await navigate({ to: "/" });
  }

  return (
    <main className="grid min-h-svh place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Logo className="text-lg" />
          <h1 className="font-semibold">{isSignUp ? "Create account" : "Sign in"}</h1>
          <FieldGroup>
            {isSignUp && (
              <Field>
                <FieldLabel htmlFor="name">Name</FieldLabel>
                <Input id="name" name="name" autoComplete="name" required />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete={isSignUp ? "email" : "email webauthn"}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignUp ? "new-password" : "current-password webauthn"}
                minLength={8}
                required
              />
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {isSignUp ? "Create account" : "Sign in"}
          </Button>
          {!isSignUp && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void onPasskey()}
            >
              <HugeiconsIcon icon={FingerPrintIcon} className="size-4" />
              Sign in with passkey
            </Button>
          )}
          {(isSignUp || signupOpen) && (
            <p className="text-muted-foreground">
              {isSignUp ? "Have an account? " : "No account? "}
              <Link to={isSignUp ? "/sign-in" : "/sign-up"} className="font-medium text-foreground">
                {isSignUp ? "Sign in" : "Sign up"}
              </Link>
            </p>
          )}
        </form>
      </Card>
    </main>
  );
}
