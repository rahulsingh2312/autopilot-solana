import { cookies } from "next/headers";

import { ADMIN_SESSION_COOKIE, verifySession } from "@/lib/admin/session";
import { AdminConsole } from "./console";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Copycat, operations",
  robots: { index: false, follow: false },
};

/**
 * The operations console.
 *
 * Server component so the session check happens before any markup is produced:
 * an unauthenticated visitor gets the login form and never a flash of tracker
 * state. All the live data arrives client-side through the proxy, because it
 * is chain state that changes while the page is open.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; tracker?: string }>;
}) {
  const { error, tracker } = await searchParams;
  const session = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;

  if (!(await verifySession(session))) {
    return <LoginForm error={error} />;
  }

  return <AdminConsole initialTracker={tracker} />;
}

function LoginForm({ error }: { error?: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <form action="/admin/login" method="post" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="display text-3xl text-ink">Operations</h1>
          <p className="text-sm text-muted">
            Tracker ingestion, rebalance approval, and vault controls.
          </p>
        </div>

        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          required
          autoFocus
          className="rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-rule-strong"
        />

        {error ? (
          <p className="text-sm text-neg">
            {error === "config"
              ? "ADMIN_PANEL_PASSWORD is not configured on this deployment."
              : "That password is not right."}
          </p>
        ) : null}

        <button
          type="submit"
          className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
