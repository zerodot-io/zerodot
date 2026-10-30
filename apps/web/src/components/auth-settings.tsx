// SPDX-License-Identifier: AGPL-3.0-only
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { authClient } from "@zerodot/auth/client";
import { Button, Field, FieldGroup, FieldLabel, Input, Skeleton, toast } from "@zerodot/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";

type Passkey = NonNullable<
  Awaited<ReturnType<typeof authClient.passkey.listUserPasskeys>>["data"]
>[number];

function PasskeyPrint() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-5 shrink-0 text-muted-foreground"
    >
      <path d="M7.42857 3.36201C11.3996 0.664089 17.136 2.12432 19.2301 6.41803M10.8571 21.9236C15.5839 22.5822 20 18.8952 20 14.2103V10.3333M7.42857 20.6058C5.35602 19.1977 4 16.8583 4 14.2103V9.75757C4 8.57285 4.27144 7.44988 4.75704 6.44444" />
      <path d="M16 13.8C16 16.1196 14.2091 18 12 18C9.79086 18 8 16.1196 8 13.8V10.2C8 9.55584 8.13811 8.94555 8.38493 8.4M12 6C14.2091 6 16 7.8804 16 10.2" />
      <path d="M12 10.5L12 13.5" />
    </svg>
  );
}

/** The name and email of the signed-in user. */
export function AccountForm() {
  const { data: session, isPending, refetch } = authClient.useSession();
  const [saving, setSaving] = useState(false);

  if (isPending || !session) return <Skeleton className="h-40 w-full rounded-xl" />;
  const { user } = session;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const email = String(form.get("email")).trim();
    setSaving(true);
    try {
      if (name !== user.name) {
        const { error } = await authClient.updateUser({ name });
        if (error) throw new Error(error.message ?? "Could not change the name");
      }
      if (email !== user.email) {
        const { error } = await authClient.changeEmail({ newEmail: email });
        if (error) throw new Error(error.message ?? "Could not change the email");
      }
      await refetch();
      toast.success("Saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border p-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="account-name">Name</FieldLabel>
          <Input
            id="account-name"
            name="name"
            autoComplete="name"
            defaultValue={user.name}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="account-email">Email</FieldLabel>
          <Input
            id="account-email"
            name="email"
            type="email"
            autoComplete="email"
            defaultValue={user.email}
            required
          />
        </Field>
      </FieldGroup>
      <Button type="submit" className="self-start" disabled={saving}>
        Save
      </Button>
    </form>
  );
}

/** Changes the password. Other sessions are signed out. */
export function PasswordForm() {
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    setSaving(true);
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get("currentPassword")),
      newPassword: String(form.get("newPassword")),
      revokeOtherSessions: true,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message ?? "Could not change the password");
      return;
    }
    target.reset();
    toast.success("Password changed");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border p-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="current-password">Current password</FieldLabel>
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-password">New password</FieldLabel>
          <Input
            id="new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
      </FieldGroup>
      <Button type="submit" className="self-start" disabled={saving}>
        Change password
      </Button>
    </form>
  );
}

/** Lists, adds and removes the passkeys of the signed-in user. */
export function PasskeyList() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await authClient.passkey.listUserPasskeys();
    if (error) toast.error(error.message ?? "Could not load passkeys");
    setPasskeys(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setPending(true);
    const result = await authClient.passkey.addPasskey();
    setPending(false);
    if (result?.error) {
      toast.error(result.error.message ?? "Could not add the passkey");
      return;
    }
    toast.success("Passkey added");
    await load();
  }

  async function remove(id: string) {
    setPending(true);
    const { error } = await authClient.passkey.deletePasskey({ id });
    setPending(false);
    if (error) {
      toast.error(error.message ?? "Could not remove the passkey");
      return;
    }
    await load();
  }

  return (
    <div className="divide-y overflow-hidden rounded-xl border">
      {passkeys === null ? (
        <div className="p-4">
          <Skeleton className="h-4 w-48" />
        </div>
      ) : passkeys.length === 0 ? (
        <p className="p-4 text-muted-foreground">
          No passkeys yet. Add one to sign in with your device instead of a password.
        </p>
      ) : (
        passkeys.map((key) => (
          <div key={key.id} className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-center gap-3">
              <PasskeyPrint />
              <div className="flex flex-col gap-1">
                <span className="font-medium">{key.name || "Passkey"}</span>
                <span className="text-muted-foreground">
                  Added {new Date(key.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove passkey"
              disabled={pending}
              onClick={() => void remove(key.id)}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4" />
            </Button>
          </div>
        ))
      )}
      <div className="p-4">
        <Button variant="outline" disabled={pending} onClick={() => void add()}>
          Add passkey
        </Button>
      </div>
    </div>
  );
}
